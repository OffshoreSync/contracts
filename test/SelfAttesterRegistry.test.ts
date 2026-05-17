// Unit tests for SelfAttesterRegistry. Run against a local anvil-zksync:
//
//   yarn node:start          # in another terminal — leave running
//   yarn test                # this file + others
//
// Tests use multiple anvil-zksync rich wallets via `test/helpers/wallets.ts`
// because the inMemoryNode network only registers the deployer wallet.

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers'; // augments chai with .revertedWithCustomError, .emit, etc.

import { richWallets } from './helpers/wallets';

describe('SelfAttesterRegistry', () => {
  let deployerWallet: Wallet;
  let owner: Wallet;
  let other: Wallet;
  let attesterA: ethers.HDNodeWallet; // off-chain signer; doesn't need funding
  let attesterB: ethers.HDNodeWallet;
  let registry: Contract;

  // Test message constants
  const messageHash = ethers.keccak256(ethers.toUtf8Bytes('hello-self'));

  beforeEach(async () => {
    const wallets = richWallets();
    deployerWallet = wallets[0];
    owner = wallets[1];
    other = wallets[2];

    // Off-chain attester wallets — only need a private key for signing.
    attesterA = ethers.Wallet.createRandom();
    attesterB = ethers.Wallet.createRandom();

    const deployer = new Deployer(hre, deployerWallet);
    const artifact = await deployer.loadArtifact('SelfAttesterRegistry');
    registry = await deployer.deploy(artifact, [
      owner.address,
      [attesterA.address],
    ]);
  });

  describe('constructor', () => {
    it('seeds the initial owner and attester(s)', async () => {
      expect(await registry.owner()).to.equal(owner.address);
      expect(await registry.isTrustedAttester(attesterA.address)).to.equal(true);
      expect(await registry.trustedAttesterCount()).to.equal(1n);
    });

    it('reverts if the initial owner is the zero address', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('SelfAttesterRegistry');
      await expect(
        deployer.deploy(artifact, [ethers.ZeroAddress, []]),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });
  });

  describe('addAttester', () => {
    it('adds a new attester when called by the owner', async () => {
      await (registry.connect(owner) as Contract).addAttester(attesterB.address);
      expect(await registry.isTrustedAttester(attesterB.address)).to.equal(true);
      expect(await registry.trustedAttesterCount()).to.equal(2n);
    });

    it('emits AttesterAdded', async () => {
      await expect((registry.connect(owner) as Contract).addAttester(attesterB.address))
        .to.emit(registry, 'AttesterAdded')
        .withArgs(attesterB.address);
    });

    it('reverts NotOwner when called by a non-owner', async () => {
      await expect(
        (registry.connect(other) as Contract).addAttester(attesterB.address),
      ).to.be.revertedWithCustomError(registry, 'NotOwner');
    });

    it('reverts ZeroAddress when adding 0x0', async () => {
      await expect(
        (registry.connect(owner) as Contract).addAttester(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });

    it('reverts AlreadyTrusted when adding a duplicate', async () => {
      await expect(
        (registry.connect(owner) as Contract).addAttester(attesterA.address),
      ).to.be.revertedWithCustomError(registry, 'AlreadyTrusted');
    });
  });

  describe('addAttesters (batch)', () => {
    it('adds multiple attesters in one call', async () => {
      const a = ethers.Wallet.createRandom().address;
      const b = ethers.Wallet.createRandom().address;
      await (registry.connect(owner) as Contract).addAttesters([a, b]);
      expect(await registry.isTrustedAttester(a)).to.equal(true);
      expect(await registry.isTrustedAttester(b)).to.equal(true);
      expect(await registry.trustedAttesterCount()).to.equal(3n);
    });
  });

  describe('removeAttester', () => {
    it('removes an existing attester when called by the owner', async () => {
      await (registry.connect(owner) as Contract).removeAttester(attesterA.address);
      expect(await registry.isTrustedAttester(attesterA.address)).to.equal(false);
      expect(await registry.trustedAttesterCount()).to.equal(0n);
    });

    it('emits AttesterRemoved', async () => {
      await expect((registry.connect(owner) as Contract).removeAttester(attesterA.address))
        .to.emit(registry, 'AttesterRemoved')
        .withArgs(attesterA.address);
    });

    it('reverts NotTrusted when removing an unknown attester', async () => {
      await expect(
        (registry.connect(owner) as Contract).removeAttester(attesterB.address),
      ).to.be.revertedWithCustomError(registry, 'NotTrusted');
    });

    it('reverts NotOwner when called by a non-owner', async () => {
      await expect(
        (registry.connect(other) as Contract).removeAttester(attesterA.address),
      ).to.be.revertedWithCustomError(registry, 'NotOwner');
    });
  });

  describe('two-step ownership transfer', () => {
    it('completes when the pending owner accepts', async () => {
      await (registry.connect(owner) as Contract).transferOwnership(other.address);
      expect(await registry.pendingOwner()).to.equal(other.address);
      expect(await registry.owner()).to.equal(owner.address); // not yet

      await (registry.connect(other) as Contract).acceptOwnership();
      expect(await registry.owner()).to.equal(other.address);
      expect(await registry.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it('rejects acceptOwnership from someone other than pendingOwner', async () => {
      await (registry.connect(owner) as Contract).transferOwnership(other.address);
      await expect(
        (registry.connect(owner) as Contract).acceptOwnership(),
      ).to.be.revertedWithCustomError(registry, 'NotPendingOwner');
    });

    it('rejects transferOwnership(0x0)', async () => {
      await expect(
        (registry.connect(owner) as Contract).transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });

    it('renounceOwnership leaves owner as 0x0 and disables onlyOwner', async () => {
      await (registry.connect(owner) as Contract).renounceOwnership();
      expect(await registry.owner()).to.equal(ethers.ZeroAddress);
      await expect(
        (registry.connect(owner) as Contract).addAttester(attesterB.address),
      ).to.be.revertedWithCustomError(registry, 'NotOwner');
    });
  });

  describe('verifyAttesterSig', () => {
    it('returns true for a valid sig from a trusted attester', async () => {
      // EIP-191 personal_sign — ethers.Wallet.signMessage applies the prefix.
      const sig = await attesterA.signMessage(ethers.getBytes(messageHash));
      expect(await registry.verifyAttesterSig(messageHash, sig)).to.equal(true);
    });

    it('returns false for a valid sig from an UNtrusted attester', async () => {
      const sig = await attesterB.signMessage(ethers.getBytes(messageHash));
      expect(await registry.verifyAttesterSig(messageHash, sig)).to.equal(false);
    });

    it('returns false after the trusted attester is removed', async () => {
      const sig = await attesterA.signMessage(ethers.getBytes(messageHash));
      await (registry.connect(owner) as Contract).removeAttester(attesterA.address);
      expect(await registry.verifyAttesterSig(messageHash, sig)).to.equal(false);
    });

    it('reverts InvalidSignatureLength on a too-short signature', async () => {
      const tooShort = '0x' + '00'.repeat(64); // 64 bytes, missing v
      await expect(
        registry.verifyAttesterSig(messageHash, tooShort),
      ).to.be.revertedWithCustomError(registry, 'InvalidSignatureLength');
    });

    it('reverts InvalidSignatureValueV on bogus v byte', async () => {
      // Build a sig whose v byte is 99 (not 27 or 28).
      const realSig = await attesterA.signMessage(ethers.getBytes(messageHash));
      const tampered = realSig.slice(0, -2) + '63'; // last byte = 0x63 = 99
      await expect(
        registry.verifyAttesterSig(messageHash, tampered),
      ).to.be.revertedWithCustomError(registry, 'InvalidSignatureValueV');
    });

    it('reverts InvalidSignatureValueS on a malleable (high-s) signature', async () => {
      // Take a real sig, flip s -> n - s, flip v parity. The resulting sig
      // recovers to the same address but with high-s — registry must reject.
      const realSig = await attesterA.signMessage(ethers.getBytes(messageHash));
      const sigStruct = ethers.Signature.from(realSig);
      // secp256k1 curve order N
      const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
      const malleableS = N - BigInt(sigStruct.s);
      const malleableV = sigStruct.v === 27 ? 28 : 27;
      const malleableSig =
        sigStruct.r +
        ethers.toBeHex(malleableS, 32).slice(2) +
        (malleableV === 27 ? '1b' : '1c');
      await expect(
        registry.verifyAttesterSig(messageHash, malleableSig),
      ).to.be.revertedWithCustomError(registry, 'InvalidSignatureValueS');
    });
  });

  describe('toEthSignedMessageHash', () => {
    it('matches ethers personal_sign prefix', async () => {
      const onChain = await registry.toEthSignedMessageHash(messageHash);
      const offChain = ethers.hashMessage(ethers.getBytes(messageHash));
      expect(onChain).to.equal(offChain);
    });
  });
});
