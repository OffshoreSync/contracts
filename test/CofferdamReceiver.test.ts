// Unit tests for CofferdamReceiver (α-2 identity registry).
//
// Run against a local anvil-zksync:
//   yarn node:start          # in another terminal — leave running
//   yarn test                # this file + others
//
// Coverage:
//   - constructor seeds owner; rejects zero
//   - bindNullifier auth gate (onlyOwner) and zero-value rejection
//   - one-shot replay guards (account → nullifier and nullifier → account)
//   - all three IIdentityRegistry read functions (isAccountBound,
//     isNullifierBound, verifiedAt)
//   - NullifierBound event topic stability (matches v2/self/NullifierRegistry
//     by name so downstream indexers can subscribe agnostically across eras)
//   - two-step ownership transfer

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets } from './helpers/wallets';

describe('CofferdamReceiver', () => {
  let deployerWallet: Wallet;
  let owner: Wallet;
  let other: Wallet;
  let account: Wallet;
  let receiver: Contract;

  const nullifierA = ethers.keccak256(ethers.toUtf8Bytes('nullifier-A'));
  const nullifierB = ethers.keccak256(ethers.toUtf8Bytes('nullifier-B'));

  beforeEach(async () => {
    const wallets = richWallets();
    deployerWallet = wallets[0];
    owner = wallets[1];
    other = wallets[2];
    account = wallets[3];

    const deployer = new Deployer(hre, deployerWallet);
    const artifact = await deployer.loadArtifact('CofferdamReceiver');
    receiver = await deployer.deploy(artifact, [owner.address]);
  });

  describe('constructor', () => {
    it('seeds the initial owner', async () => {
      expect(await receiver.owner()).to.equal(owner.address);
    });

    it('reverts on zero-address owner', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('CofferdamReceiver');
      await expect(
        deployer.deploy(artifact, [ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(receiver, 'ZeroAddress');
    });
  });

  describe('bindNullifier', () => {
    it('binds account ↔ nullifier and emits NullifierBound', async () => {
      const tx = await (receiver.connect(owner) as Contract).bindNullifier(
        account.address,
        nullifierA,
      );
      const receipt = await tx.wait();
      const block = await deployerWallet.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(receiver, 'NullifierBound')
        .withArgs(account.address, nullifierA, block.timestamp);

      expect(await receiver.accountToNullifier(account.address)).to.equal(nullifierA);
      expect(await receiver.nullifierToAccount(nullifierA)).to.equal(account.address);
      expect(await receiver.verifiedAt(account.address)).to.equal(BigInt(block.timestamp));
    });

    it('flips isAccountBound / isNullifierBound', async () => {
      expect(await receiver.isAccountBound(account.address)).to.equal(false);
      expect(await receiver.isNullifierBound(nullifierA)).to.equal(false);

      await (receiver.connect(owner) as Contract).bindNullifier(
        account.address,
        nullifierA,
      );

      expect(await receiver.isAccountBound(account.address)).to.equal(true);
      expect(await receiver.isNullifierBound(nullifierA)).to.equal(true);
    });

    it('reverts NotOwner when called by a non-owner', async () => {
      await expect(
        (receiver.connect(other) as Contract).bindNullifier(account.address, nullifierA),
      ).to.be.revertedWithCustomError(receiver, 'NotOwner');
    });

    it('reverts ZeroAddress on account 0x0', async () => {
      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(ethers.ZeroAddress, nullifierA),
      ).to.be.revertedWithCustomError(receiver, 'ZeroAddress');
    });

    it('reverts ZeroNullifier on bytes32(0)', async () => {
      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(account.address, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(receiver, 'ZeroNullifier');
    });

    it('reverts AccountAlreadyBound on account replay', async () => {
      await (receiver.connect(owner) as Contract).bindNullifier(account.address, nullifierA);
      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(account.address, nullifierB),
      )
        .to.be.revertedWithCustomError(receiver, 'AccountAlreadyBound')
        .withArgs(account.address, nullifierA);
    });

    it('reverts NullifierAlreadyBound on nullifier replay', async () => {
      await (receiver.connect(owner) as Contract).bindNullifier(account.address, nullifierA);
      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(other.address, nullifierA),
      )
        .to.be.revertedWithCustomError(receiver, 'NullifierAlreadyBound')
        .withArgs(nullifierA, account.address);
    });
  });

  describe('two-step ownership transfer', () => {
    it('completes when the pending owner accepts', async () => {
      await (receiver.connect(owner) as Contract).transferOwnership(other.address);
      expect(await receiver.pendingOwner()).to.equal(other.address);
      expect(await receiver.owner()).to.equal(owner.address); // not yet

      await (receiver.connect(other) as Contract).acceptOwnership();
      expect(await receiver.owner()).to.equal(other.address);
      expect(await receiver.pendingOwner()).to.equal(ethers.ZeroAddress);
    });

    it('lets the new owner bind, and the previous owner cannot', async () => {
      await (receiver.connect(owner) as Contract).transferOwnership(other.address);
      await (receiver.connect(other) as Contract).acceptOwnership();

      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(account.address, nullifierA),
      ).to.be.revertedWithCustomError(receiver, 'NotOwner');

      await (receiver.connect(other) as Contract).bindNullifier(account.address, nullifierA);
      expect(await receiver.isAccountBound(account.address)).to.equal(true);
    });

    it('rejects acceptOwnership from someone other than pendingOwner', async () => {
      await (receiver.connect(owner) as Contract).transferOwnership(other.address);
      await expect(
        (receiver.connect(owner) as Contract).acceptOwnership(),
      ).to.be.revertedWithCustomError(receiver, 'NotPendingOwner');
    });

    it('rejects transferOwnership(0x0)', async () => {
      await expect(
        (receiver.connect(owner) as Contract).transferOwnership(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(receiver, 'ZeroAddress');
    });

    it('renounceOwnership disables bindNullifier permanently', async () => {
      await (receiver.connect(owner) as Contract).renounceOwnership();
      expect(await receiver.owner()).to.equal(ethers.ZeroAddress);
      await expect(
        (receiver.connect(owner) as Contract).bindNullifier(account.address, nullifierA),
      ).to.be.revertedWithCustomError(receiver, 'NotOwner');
    });
  });
});
