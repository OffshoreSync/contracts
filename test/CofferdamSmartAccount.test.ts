// Integration tests for the native ZKSync Era Account Abstraction stack:
//   CofferdamSmartAccount (IAccount) + CofferdamAccountFactory (create2Account)
//   + CofferdamPaymaster (general-flow sponsor).
//
// These exercise the REAL bootloader-driven AA path on anvil-zksync (type-113
// txs), not the custom-`execute` harness covered by CofferdamAccount.test.ts.
// They prove the shared AuthorityManagerBase behaves identically under native
// validation: tiered signature gating, the legacy→passkey ratchet, and that a
// zero-balance passkey account can transact via the paymaster.

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract, Provider, utils, EIP712Signer, types } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets, testProvider } from './helpers/wallets';
import {
  generateP256Key,
  signP256,
  sessionConfig,
  signSession,
  type P256Key,
} from './helpers/authority';

const Tier = { None: 0, LowUntrusted: 1, LowManaged: 2, High: 3 } as const;
const abi = ethers.AbiCoder.defaultAbiCoder();

type SignFn = (signedHash: string) => string | Promise<string>;

describe('CofferdamSmartAccount (native AA)', () => {
  let provider: Provider;
  let deployerWallet: Wallet;
  let deployer: Deployer;
  let chainId: bigint;

  let accountArtifactAbi: any;
  let factory: Contract;
  let paymaster: Contract;

  let passkeyModAddr: string;
  let untrustedModAddr: string;
  let echo: Contract;
  let echoAddr: string;

  let serverKey: ethers.HDNodeWallet;
  let passkey: P256Key;

  before(async () => {
    provider = testProvider();
    deployerWallet = richWallets(provider)[0];
    deployer = new Deployer(hre, deployerWallet);
    chainId = (await provider.getNetwork()).chainId;
  });

  beforeEach(async () => {
    const passkeyMod = await deployer.deploy(await deployer.loadArtifact('PasskeyAuthority'), []);
    const untrustedMod = await deployer.deploy(
      await deployer.loadArtifact('SessionKeyAuthority'),
      [Tier.LowUntrusted],
    );
    echo = await deployer.deploy(await deployer.loadArtifact('CallEcho'), []);
    passkeyModAddr = await passkeyMod.getAddress();
    untrustedModAddr = await untrustedMod.getAddress();
    echoAddr = await echo.getAddress();

    // Factory carries the account bytecode as a factoryDep so create2Account works.
    const accountArtifact = await deployer.loadArtifact('CofferdamSmartAccount');
    accountArtifactAbi = accountArtifact.abi;
    const bytecodeHash = utils.hashBytecode(accountArtifact.bytecode);
    factory = await deployer.deploy(
      await deployer.loadArtifact('CofferdamAccountFactory'),
      [bytecodeHash],
      undefined,
      {},
      [accountArtifact.bytecode],
    );

    // Paymaster starts open (sponsor-all); individual tests flip it as needed.
    paymaster = await deployer.deploy(await deployer.loadArtifact('CofferdamPaymaster'), [true]);

    serverKey = ethers.Wallet.createRandom();
    passkey = generateP256Key();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function deployAccount(moduleAddr: string, config: string, saltLabel: string): Promise<{ account: Contract; addr: string }> {
    const salt = ethers.id(saltLabel);
    const counterfactual: string = await factory.getAccountAddress(salt, moduleAddr, config);
    await (await factory.deployAccount(salt, moduleAddr, config)).wait();
    const account = new Contract(counterfactual, accountArtifactAbi, deployerWallet);
    return { account, addr: counterfactual };
  }

  async function fund(addr: string, eth: string) {
    await (await deployerWallet.sendTransaction({ to: addr, value: ethers.parseEther(eth) })).wait();
  }

  const pokeData = (arg: number) =>
    new ethers.Interface(['function poke(uint256 arg)']).encodeFunctionData('poke', [arg]);

  interface AaTxOpts {
    accountAddr: string;
    authorityId: number;
    sign: SignFn;
    to: string;
    data: string;
    value?: bigint;
    paymasterAddr?: string;
  }

  /** Build + sign a native AA tx, returning the populated request and its
   *  serialized form. */
  async function buildAaTx(opts: AaTxOpts): Promise<{ tx: types.TransactionRequest; serialized: string }> {
    const gasPrice = await provider.getGasPrice();
    const tx: types.TransactionRequest = {
      type: utils.EIP712_TX_TYPE,
      from: opts.accountAddr,
      to: opts.to,
      data: opts.data,
      value: opts.value ?? 0n,
      chainId,
      nonce: await provider.getTransactionCount(opts.accountAddr),
      gasLimit: 30_000_000n,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
      customData: { gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT } as types.Eip712Meta,
    };
    if (opts.paymasterAddr) {
      tx.customData!.paymasterParams = utils.getPaymasterParams(opts.paymasterAddr, {
        type: 'General',
        innerInput: new Uint8Array(),
      });
    }

    const signedHash = EIP712Signer.getSignedDigest(tx) as string;
    const inner = await opts.sign(signedHash);
    tx.customData!.customSignature = abi.encode(['uint256', 'bytes'], [opts.authorityId, inner]);

    return { tx, serialized: utils.serializeEip712(tx as any) };
  }

  /** Build, sign, broadcast, and await a native AA tx. */
  async function sendAaTx(opts: AaTxOpts): Promise<ethers.TransactionReceipt> {
    const { serialized } = await buildAaTx(opts);
    const sent = await provider.broadcastTransaction(serialized);
    return sent.wait();
  }

  /** Assert a native AA tx is rejected because its EXECUTION or PAYMASTER step
   *  reverts. `estimateGas` runs both server-side and rejects synchronously.
   *  (It does NOT enforce the account's validation magic — see
   *  `expectAaNotMined` for pure bad-signature / wrong-tier cases.) */
  async function expectAaRejected(opts: AaTxOpts): Promise<void> {
    const { tx } = await buildAaTx(opts);
    await expect(provider.estimateGas(tx)).to.be.rejected;
  }

  /** Assert an AA tx fails ACCOUNT VALIDATION (returns a zero magic). Such a tx
   *  is admitted to the mempool but the bootloader never includes it, so it is
   *  never mined — whereas a valid tx auto-mines on `inMemoryNode` within ms.
   *  We therefore broadcast and assert no receipt ever appears. */
  async function expectAaNotMined(opts: AaTxOpts): Promise<void> {
    const { serialized } = await buildAaTx(opts);
    let hash: string;
    try {
      hash = (await provider.broadcastTransaction(serialized)).hash;
    } catch {
      return; // rejected at submission — unambiguously invalid
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const receipt = await provider.getTransactionReceipt(hash);
    expect(receipt, 'a tx failing account validation must never be mined').to.equal(null);
  }

  const signWithPasskey = (key: P256Key): SignFn => (hash) => signP256(key.priv, hash);
  const signWithSession = (signer: ethers.HDNodeWallet, accountAddr: string): SignFn =>
    (hash) => signSession(signer, accountAddr, hash);

  // ── Factory / counterfactual address ─────────────────────────────────────────

  describe('factory', () => {
    it('getAccountAddress matches the actually-deployed account', async () => {
      const salt = ethers.id('cf-check');
      const predicted: string = await factory.getAccountAddress(salt, passkeyModAddr, passkey.config);
      await (await factory.deployAccount(salt, passkeyModAddr, passkey.config)).wait();
      // Code is now present at the predicted address.
      expect(await provider.getCode(predicted)).to.not.equal('0x');
    });

    it('bootstraps the account with its initial authority', async () => {
      const { account } = await deployAccount(passkeyModAddr, passkey.config, 'cf-bootstrap');
      expect(await account.authorityCount()).to.equal(1);
      expect(await account.passkeyCount()).to.equal(1);
      expect(await account.upgradeLocked()).to.equal(true);
    });
  });

  // ── Native execution + tier gating ───────────────────────────────────────────

  describe('execution', () => {
    it('High passkey executes a call via the bootloader (self-funded)', async () => {
      const { account, addr } = await deployAccount(passkeyModAddr, passkey.config, 'exec-passkey');
      await fund(addr, '1');

      await sendAaTx({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithPasskey(passkey),
        to: echoAddr,
        data: pokeData(42),
      });

      expect(await echo.lastArg()).to.equal(42);
      expect(await echo.lastCaller()).to.equal(addr);
      expect(await provider.getTransactionCount(addr)).to.equal(1);
    });

    it('rejects a transaction signed by the wrong passkey', async () => {
      const { addr } = await deployAccount(passkeyModAddr, passkey.config, 'exec-badsig');
      await fund(addr, '1');
      const wrong = generateP256Key();
      await expectAaNotMined({ accountAddr: addr, authorityId: 0, sign: signWithPasskey(wrong), to: echoAddr, data: pokeData(1) });
    });

    it('LowUntrusted may NOT execute an arbitrary call', async () => {
      const { addr } = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address), 'exec-untrusted');
      await fund(addr, '1');
      await expectAaNotMined({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithSession(serverKey, addr),
        to: echoAddr,
        data: pokeData(1),
      });
    });
  });

  // ── Legacy → passkey ratchet (native) ────────────────────────────────────────

  describe('enrollFirstPasskey ratchet', () => {
    it('LowUntrusted self-call enrols the first passkey, then is locked out', async () => {
      const { account, addr } = await deployAccount(
        untrustedModAddr,
        sessionConfig(serverKey.address),
        'ratchet',
      );
      await fund(addr, '1');

      const enrollData = account.interface.encodeFunctionData('enrollFirstPasskey', [
        passkeyModAddr,
        passkey.config,
      ]);

      // Authorised by the LowUntrusted session, as a zero-value self-call.
      await sendAaTx({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithSession(serverKey, addr),
        to: addr,
        data: enrollData,
      });

      expect(await account.upgradeLocked()).to.equal(true);
      expect(await account.passkeyCount()).to.equal(1);
      const [, , active0] = await account.getAuthority(0);
      expect(active0).to.equal(false); // session deactivated
      const [mod1, tier1, active1] = await account.getAuthority(1);
      expect(mod1).to.equal(passkeyModAddr);
      expect(tier1).to.equal(Tier.High);
      expect(active1).to.equal(true);

      // New passkey (authority 1) can now execute.
      await sendAaTx({
        accountAddr: addr,
        authorityId: 1,
        sign: signWithPasskey(passkey),
        to: echoAddr,
        data: pokeData(7),
      });
      expect(await echo.lastArg()).to.equal(7);

      // The locked-out session (authority 0) can no longer act.
      await expectAaRejected({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithSession(serverKey, addr),
        to: addr,
        data: enrollData,
      });
    });
  });

  // ── Paymaster (gas sponsorship) ───────────────────────────────────────────────

  describe('paymaster', () => {
    it('sponsors a ZERO-balance passkey account (open mode)', async () => {
      const { addr } = await deployAccount(passkeyModAddr, passkey.config, 'pm-open');
      const paymasterAddr = await paymaster.getAddress();
      await fund(paymasterAddr, '1'); // fund the sponsor, NOT the account

      expect(await provider.getBalance(addr)).to.equal(0n);
      await sendAaTx({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithPasskey(passkey),
        to: echoAddr,
        data: pokeData(123),
        paymasterAddr,
      });
      expect(await echo.lastArg()).to.equal(123);
      expect(await provider.getBalance(addr)).to.equal(0n); // never paid a fee
    });

    it('in allowlist mode, rejects an unsponsored account but allows a sponsored one', async () => {
      const paymasterAddr = await paymaster.getAddress();
      await fund(paymasterAddr, '1');
      await (await paymaster.setOpen(false)).wait();

      const { addr } = await deployAccount(passkeyModAddr, passkey.config, 'pm-allowlist');

      // Not yet allowlisted → paymaster validation reverts → tx fails.
      await expectAaRejected({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithPasskey(passkey),
        to: echoAddr,
        data: pokeData(1),
        paymasterAddr,
      });

      // Allowlist it → now sponsored.
      await (await paymaster.setSponsored(addr, true)).wait();
      await sendAaTx({
        accountAddr: addr,
        authorityId: 0,
        sign: signWithPasskey(passkey),
        to: echoAddr,
        data: pokeData(456),
        paymasterAddr,
      });
      expect(await echo.lastArg()).to.equal(456);
    });
  });
});
