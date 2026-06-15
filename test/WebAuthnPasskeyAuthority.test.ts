// Tests for WebAuthnPasskeyAuthority — the High-tier authority that verifies a
// REAL WebAuthn (react-native-passkeys / navigator.credentials) assertion, as
// opposed to PasskeyAuthority's raw P-256 over the bare digest.
//
// Two layers:
//   1. Unit: isValidSignature against a synthesised WebAuthn assertion whose
//      challenge is the digest (valid, wrong-key, tampered, UV-gating).
//   2. Native account: an account bootstrapped with this module as its High
//      authority executes a paymaster-sponsored type-113 tx from a ZERO balance,
//      authorised purely by the WebAuthn assertion — the exact RN-app flow.

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract, Provider, utils, EIP712Signer, types } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets, testProvider } from './helpers/wallets';
import { generateP256Key, signWebAuthn, type P256Key } from './helpers/authority';

const abi = ethers.AbiCoder.defaultAbiCoder();
const ZERO = '0x0000000000000000000000000000000000000000';

// authenticatorData flag bytes.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

describe('WebAuthnPasskeyAuthority', () => {
  let provider: Provider;
  let deployerWallet: Wallet;
  let deployer: Deployer;
  let chainId: bigint;
  let passkey: P256Key;

  before(async () => {
    provider = testProvider();
    deployerWallet = richWallets(provider)[0];
    deployer = new Deployer(hre, deployerWallet);
    chainId = (await provider.getNetwork()).chainId;
  });

  beforeEach(() => {
    passkey = generateP256Key();
  });

  // ── Unit ─────────────────────────────────────────────────────────────────

  describe('isValidSignature', () => {
    let mod: Contract; // requireUV is a compile-time constant `true`

    beforeEach(async () => {
      mod = await deployer.deploy(await deployer.loadArtifact('WebAuthnPasskeyAuthority'), []);
    });

    const digest = ethers.id('a-transaction-hash');

    it('accepts a well-formed WebAuthn assertion over the digest', async () => {
      const sig = signWebAuthn(passkey.priv, digest);
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, sig)).to.equal(true);
    });

    it('reports High tier and passkey kind', async () => {
      expect(await mod.tier()).to.equal(3);
      expect(await mod.kind()).to.equal(ethers.id('passkey'));
      expect(await mod.requireUserVerification()).to.equal(true);
    });

    it('rejects an assertion from a different key', async () => {
      const wrong = generateP256Key();
      const sig = signWebAuthn(wrong.priv, digest);
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, sig)).to.equal(false);
    });

    it('rejects when the signed challenge is a DIFFERENT digest', async () => {
      const sig = signWebAuthn(passkey.priv, ethers.id('some-other-hash'));
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, sig)).to.equal(false);
    });

    it('rejects malformed / too-short signature bytes', async () => {
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, '0x1234')).to.equal(false);
    });

    it('rejects a config that is not 64 bytes', async () => {
      const sig = signWebAuthn(passkey.priv, digest);
      const badConfig = abi.encode(['bytes32'], [passkey.qx]);
      expect(await mod.isValidSignature(ZERO, digest, badConfig, sig)).to.equal(false);
    });

    it('rejects an assertion without the UV flag (UV is required)', async () => {
      // UP|BE|BS but no UV.
      const sig = signWebAuthn(passkey.priv, digest, FLAG_UP | FLAG_BE | FLAG_BS);
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, sig)).to.equal(false);
    });

    it('rejects an assertion missing the User-Present (UP) flag even with UV set', async () => {
      const sig = signWebAuthn(passkey.priv, digest, FLAG_UV); // UV set, UP clear
      expect(await mod.isValidSignature(ZERO, digest, passkey.config, sig)).to.equal(false);
    });
  });

  // ── Native account end-to-end ──────────────────────────────────────────────

  describe('native account authorisation', () => {
    let factory: Contract;
    let paymaster: Contract;
    let echo: Contract;
    let echoAddr: string;
    let modAddr: string;
    let accountArtifactAbi: any;

    beforeEach(async () => {
      const mod = await deployer.deploy(
        await deployer.loadArtifact('WebAuthnPasskeyAuthority'),
        [],
      );
      modAddr = await mod.getAddress();

      echo = await deployer.deploy(await deployer.loadArtifact('CallEcho'), []);
      echoAddr = await echo.getAddress();

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
      paymaster = await deployer.deploy(await deployer.loadArtifact('CofferdamPaymaster'), [true]);
    });

    async function deployAccount(saltLabel: string): Promise<{ account: Contract; addr: string }> {
      const salt = ethers.id(saltLabel);
      const addr: string = await factory.getAccountAddress(salt, modAddr, passkey.config);
      await (await factory.deployAccount(salt, modAddr, passkey.config)).wait();
      return { account: new Contract(addr, accountArtifactAbi, deployerWallet), addr };
    }

    const pokeData = (arg: number) =>
      new ethers.Interface(['function poke(uint256 arg)']).encodeFunctionData('poke', [arg]);

    async function sendAaTx(accountAddr: string, to: string, data: string, paymasterAddr?: string) {
      const gasPrice = await provider.getGasPrice();
      const tx: types.TransactionRequest = {
        type: utils.EIP712_TX_TYPE,
        from: accountAddr,
        to,
        data,
        value: 0n,
        chainId,
        nonce: await provider.getTransactionCount(accountAddr),
        gasLimit: 30_000_000n,
        maxFeePerGas: gasPrice,
        maxPriorityFeePerGas: gasPrice,
        customData: { gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT } as types.Eip712Meta,
      };
      if (paymasterAddr) {
        tx.customData!.paymasterParams = utils.getPaymasterParams(paymasterAddr, {
          type: 'General',
          innerInput: new Uint8Array(),
        });
      }
      const signedHash = EIP712Signer.getSignedDigest(tx) as string;
      const inner = signWebAuthn(passkey.priv, signedHash);
      tx.customData!.customSignature = abi.encode(['uint256', 'bytes'], [0, inner]);
      const sent = await provider.broadcastTransaction(utils.serializeEip712(tx as any));
      return sent.wait();
    }

    it('bootstraps an account governed by the WebAuthn passkey', async () => {
      const { account } = await deployAccount('wa-bootstrap');
      expect(await account.authorityCount()).to.equal(1);
      expect(await account.passkeyCount()).to.equal(1);
      expect(await account.upgradeLocked()).to.equal(true);
      const [mod0, tier0, active0] = await account.getAuthority(0);
      expect(mod0).to.equal(modAddr);
      expect(tier0).to.equal(3); // High
      expect(active0).to.equal(true);
    });

    it('a WebAuthn passkey authorises a paymaster-sponsored tx from a ZERO-balance account', async () => {
      const { addr } = await deployAccount('wa-sponsored');
      const paymasterAddr = await paymaster.getAddress();
      await (
        await deployerWallet.sendTransaction({ to: paymasterAddr, value: ethers.parseEther('1') })
      ).wait();

      expect(await provider.getBalance(addr)).to.equal(0n);
      await sendAaTx(addr, echoAddr, pokeData(2026), paymasterAddr);

      expect(await echo.lastArg()).to.equal(2026);
      expect(await echo.lastCaller()).to.equal(addr);
      expect(await provider.getBalance(addr)).to.equal(0n); // sponsor paid, account spent nothing
      expect(await provider.getTransactionCount(addr)).to.equal(1);
    });
  });
});
