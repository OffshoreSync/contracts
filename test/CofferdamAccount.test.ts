// Unit tests for the CofferdamAccount authority framework: tiered authorities,
// the one-way upgrade ratchet (legacy → passkey migration), the ≤3 passkey cap,
// per-operation signature binding + replay protection, and both concrete
// authority modules (PasskeyAuthority P-256, SessionKeyAuthority ECDSA bridge).

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets, testProvider } from './helpers/wallets';
import {
  TAG,
  accountDigest,
  executePayload,
  moduleConfigPayload,
  revokePayload,
  generateP256Key,
  signP256,
  sessionConfig,
  signSession,
  type P256Key,
} from './helpers/authority';

// Tier enum (matches IAuthorityModule.sol)
const Tier = { None: 0, LowUntrusted: 1, LowManaged: 2, High: 3 } as const;

describe('CofferdamAccount', () => {
  let deployerWallet: Wallet;
  let deployer: Deployer;
  let chainId: bigint;

  let passkeyMod: Contract; // PasskeyAuthority (High)
  let untrustedMod: Contract; // SessionKeyAuthority(LowUntrusted)
  let managedMod: Contract; // SessionKeyAuthority(LowManaged)
  let echo: Contract;

  let passkeyModAddr: string;
  let untrustedModAddr: string;
  let managedModAddr: string;
  let echoAddr: string;

  let serverKey: ethers.HDNodeWallet; // session signer (off-chain)
  let passkey: P256Key;

  beforeEach(async () => {
    deployerWallet = richWallets()[0];
    deployer = new Deployer(hre, deployerWallet);
    chainId = (await testProvider().getNetwork()).chainId;

    passkeyMod = await deployer.deploy(await deployer.loadArtifact('PasskeyAuthority'), []);
    untrustedMod = await deployer.deploy(await deployer.loadArtifact('SessionKeyAuthority'), [Tier.LowUntrusted]);
    managedMod = await deployer.deploy(await deployer.loadArtifact('SessionKeyAuthority'), [Tier.LowManaged]);
    echo = await deployer.deploy(await deployer.loadArtifact('CallEcho'), []);

    passkeyModAddr = await passkeyMod.getAddress();
    untrustedModAddr = await untrustedMod.getAddress();
    managedModAddr = await managedMod.getAddress();
    echoAddr = await echo.getAddress();

    serverKey = ethers.Wallet.createRandom();
    passkey = generateP256Key();
  });

  async function deployAccount(moduleAddr: string, config: string): Promise<Contract> {
    return deployer.deploy(await deployer.loadArtifact('CofferdamAccount'), [moduleAddr, config]);
  }

  const pokeData = (arg: number) =>
    new ethers.Interface(['function poke(uint256 arg)']).encodeFunctionData('poke', [arg]);

  // ────────────────────────────────────────────────────────────────────────
  describe('module metadata', () => {
    it('PasskeyAuthority is High tier with kind=passkey', async () => {
      expect(await passkeyMod.tier()).to.equal(Tier.High);
      expect(await passkeyMod.kind()).to.equal(ethers.id('passkey'));
    });

    it('SessionKeyAuthority encodes its deploy-time tier + kind', async () => {
      expect(await untrustedMod.tier()).to.equal(Tier.LowUntrusted);
      expect(await untrustedMod.kindOf()).to.equal(ethers.id('session'));
      expect(await managedMod.tier()).to.equal(Tier.LowManaged);
      expect(await managedMod.kindOf()).to.equal(ethers.id('polis_sso'));
    });

    it('SessionKeyAuthority rejects a High/None tier at construction', async () => {
      await expect(
        deployer.deploy(await deployer.loadArtifact('SessionKeyAuthority'), [Tier.High]),
      ).to.be.reverted;
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('constructor / bootstrap', () => {
    it('sovereign-first (passkey) → passkeyCount=1, ratchet already locked', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config);
      expect(await account.passkeyCount()).to.equal(1);
      expect(await account.upgradeLocked()).to.equal(true);
      expect(await account.authorityCount()).to.equal(1);
      const [mod, tier, active] = await account.getAuthority(0);
      expect(mod).to.equal(passkeyModAddr);
      expect(tier).to.equal(Tier.High);
      expect(active).to.equal(true);
    });

    it('legacy-first (untrusted session) → passkeyCount=0, ratchet open', async () => {
      const account = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address));
      expect(await account.passkeyCount()).to.equal(0);
      expect(await account.upgradeLocked()).to.equal(false);
    });

    it('rejects a zero module', async () => {
      await expect(deployAccount(ethers.ZeroAddress, '0x')).to.be.reverted;
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('execute — tier gating', () => {
    it('High passkey can execute (forwards arg, bumps nonce)', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config);
      const accAddr = await account.getAddress();
      const data = pokeData(42);
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      const sig = signP256(passkey.priv, digest);

      await (await account.execute(0, echoAddr, 0, data, sig)).wait();
      expect(await echo.lastArg()).to.equal(42);
      expect(await echo.lastCaller()).to.equal(accAddr);
      expect(await account.nonce()).to.equal(nonce + 1n);
    });

    it('LowManaged (Polis SSO) can execute', async () => {
      const account = await deployAccount(managedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      const data = pokeData(7);
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      const sig = await signSession(serverKey, accAddr, digest);

      await (await account.execute(0, echoAddr, 0, data, sig)).wait();
      expect(await echo.lastArg()).to.equal(7);
    });

    it('LowUntrusted cannot execute (TierNotPermitted)', async () => {
      const account = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      const data = pokeData(1);
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      const sig = await signSession(serverKey, accAddr, digest);

      await expect(account.execute(0, echoAddr, 0, data, sig)).to.be.revertedWithCustomError(
        account,
        'TierNotPermitted',
      );
    });

    it('rejects an invalid signature (InvalidAuthoritySignature)', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config);
      const accAddr = await account.getAddress();
      const data = pokeData(42);
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      // Sign with a DIFFERENT passkey.
      const bad = generateP256Key();
      const sig = signP256(bad.priv, digest);
      await expect(account.execute(0, echoAddr, 0, data, sig)).to.be.revertedWithCustomError(
        account,
        'InvalidAuthoritySignature',
      );
    });

    it('replay: a consumed signature fails after the nonce advances', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config);
      const accAddr = await account.getAddress();
      const data = pokeData(42);
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      const sig = signP256(passkey.priv, digest);
      await (await account.execute(0, echoAddr, 0, data, sig)).wait();
      await expect(account.execute(0, echoAddr, 0, data, sig)).to.be.revertedWithCustomError(
        account,
        'InvalidAuthoritySignature',
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('enrollFirstPasskey — the one-way ratchet', () => {
    it('untrusted bootstrap → enrol passkey fires ratchet + locks out the low tier', async () => {
      const account = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      const nonce = await account.nonce();
      const digest = accountDigest(
        accAddr,
        chainId,
        nonce,
        TAG.enrollFirstPasskey,
        moduleConfigPayload(passkeyModAddr, passkey.config),
      );
      const sig = await signSession(serverKey, accAddr, digest);

      await expect(account.enrollFirstPasskey(0, passkeyModAddr, passkey.config, sig))
        .to.emit(account, 'RatchetFired');

      expect(await account.upgradeLocked()).to.equal(true);
      expect(await account.passkeyCount()).to.equal(1);
      // authority 0 (the untrusted session) is now deactivated.
      const [, , active0] = await account.getAuthority(0);
      expect(active0).to.equal(false);
      // authority 1 (the new passkey) is active + High.
      const [mod1, tier1, active1] = await account.getAuthority(1);
      expect(mod1).to.equal(passkeyModAddr);
      expect(tier1).to.equal(Tier.High);
      expect(active1).to.equal(true);
    });

    it('the new passkey can execute; the locked-out session cannot', async () => {
      const account = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      let nonce = await account.nonce();
      let digest = accountDigest(
        accAddr,
        chainId,
        nonce,
        TAG.enrollFirstPasskey,
        moduleConfigPayload(passkeyModAddr, passkey.config),
      );
      await (await account.enrollFirstPasskey(0, passkeyModAddr, passkey.config, await signSession(serverKey, accAddr, digest))).wait();

      // passkey (authority 1) executes
      nonce = await account.nonce();
      const data = pokeData(99);
      digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      await (await account.execute(1, echoAddr, 0, data, signP256(passkey.priv, digest))).wait();
      expect(await echo.lastArg()).to.equal(99);

      // deactivated session (authority 0) cannot execute
      nonce = await account.nonce();
      digest = accountDigest(accAddr, chainId, nonce, TAG.execute, executePayload(echoAddr, 0n, data));
      await expect(
        account.execute(0, echoAddr, 0, data, await signSession(serverKey, accAddr, digest)),
      ).to.be.revertedWithCustomError(account, 'InactiveAuthority');
    });

    it('reverts when the signing authority is managed (NotUntrustedLowTier)', async () => {
      const account = await deployAccount(managedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      const nonce = await account.nonce();
      const digest = accountDigest(
        accAddr,
        chainId,
        nonce,
        TAG.enrollFirstPasskey,
        moduleConfigPayload(passkeyModAddr, passkey.config),
      );
      const sig = await signSession(serverKey, accAddr, digest);
      await expect(
        account.enrollFirstPasskey(0, passkeyModAddr, passkey.config, sig),
      ).to.be.revertedWithCustomError(account, 'NotUntrustedLowTier');
    });

    it('reverts a second enrolment once the ratchet has fired (PasskeyAlreadyExists)', async () => {
      const account = await deployAccount(untrustedModAddr, sessionConfig(serverKey.address));
      const accAddr = await account.getAddress();
      const nonce = await account.nonce();
      const digest = accountDigest(
        accAddr,
        chainId,
        nonce,
        TAG.enrollFirstPasskey,
        moduleConfigPayload(passkeyModAddr, passkey.config),
      );
      await (await account.enrollFirstPasskey(0, passkeyModAddr, passkey.config, await signSession(serverKey, accAddr, digest))).wait();

      const nonce2 = await account.nonce();
      const k2 = generateP256Key();
      const digest2 = accountDigest(
        accAddr,
        chainId,
        nonce2,
        TAG.enrollFirstPasskey,
        moduleConfigPayload(passkeyModAddr, k2.config),
      );
      await expect(
        account.enrollFirstPasskey(0, passkeyModAddr, k2.config, await signSession(serverKey, accAddr, digest2)),
      ).to.be.revertedWithCustomError(account, 'PasskeyAlreadyExists');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('addAuthority — passkey cap', () => {
    async function addPasskey(account: Contract, signerAuthorityId: number, signWith: P256Key, newKey: P256Key) {
      const accAddr = await account.getAddress();
      const nonce = await account.nonce();
      const digest = accountDigest(
        accAddr,
        chainId,
        nonce,
        TAG.addAuthority,
        moduleConfigPayload(passkeyModAddr, newKey.config),
      );
      const sig = signP256(signWith.priv, digest);
      return account.addAuthority(signerAuthorityId, passkeyModAddr, newKey.config, sig);
    }

    it('caps active passkeys at MAX_PASSKEYS (3)', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config); // passkey #1
      await (await addPasskey(account, 0, passkey, generateP256Key())).wait(); // #2
      await (await addPasskey(account, 0, passkey, generateP256Key())).wait(); // #3
      expect(await account.passkeyCount()).to.equal(3);
      await expect(addPasskey(account, 0, passkey, generateP256Key())).to.be.revertedWithCustomError(
        account,
        'PasskeyCapReached',
      );
    });

    it('revoking a passkey frees a slot', async () => {
      const account = await deployAccount(passkeyModAddr, passkey.config);
      await (await addPasskey(account, 0, passkey, generateP256Key())).wait(); // #2 → id 1
      expect(await account.passkeyCount()).to.equal(2);

      const accAddr = await account.getAddress();
      const nonce = await account.nonce();
      const digest = accountDigest(accAddr, chainId, nonce, TAG.revokeAuthority, revokePayload(1n));
      await (await account.revokeAuthority(0, 1, signP256(passkey.priv, digest))).wait();
      expect(await account.passkeyCount()).to.equal(1);
    });
  });
});
