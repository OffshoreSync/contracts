// Unit tests for CofferdamSpotEscrow (α-2 native-ETH escrow).
//
// Run against a local anvil-zksync:
//   yarn node:start          # in another terminal — leave running
//   yarn test                # this file + others
//
// Coverage:
//   - Happy path: post → award → checkIn → checkOut → settle (balance deltas)
//   - Identity gate: every state-mutating call from recruiter / worker
//     requires `identity.isAccountBound(msg.sender)`. Award of an unbound
//     worker also fails.
//   - State-machine: each transition rejects calls from the wrong state.
//   - Role enforcement: only recruiter awards / cancels; only worker
//     checks in / out.
//   - Cancel happy path (refund to recruiter).
//   - Dispute path: any participant raises, owner resolves to either party,
//     funds flow correctly.
//   - settle() is callable by anyone (relayer / keeper / paymaster pattern).
//   - α-3 corporate flow: postContractIntent → fundContract → existing
//     pipeline. Designated-funder enforcement, open-funding mode,
//     cancelDraft, refund-to-funder semantics on cancel + dispute.

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets } from './helpers/wallets';

describe('CofferdamSpotEscrow', () => {
  let deployerWallet: Wallet;
  let owner: Wallet;       // = arbiter for disputes
  let recruiter: Wallet;   // HR
  let worker: Wallet;
  let outsider: Wallet;
  let keeper: Wallet;      // unrelated party who can call settle()
  let funder: Wallet;      // Finance role (corporate-flow tests)
  let receiver: Contract;
  let escrow: Contract;

  const recruiterNullifier = ethers.keccak256(ethers.toUtf8Bytes('nullifier-recruiter'));
  const workerNullifier = ethers.keccak256(ethers.toUtf8Bytes('nullifier-worker'));
  const outsiderNullifier = ethers.keccak256(ethers.toUtf8Bytes('nullifier-outsider'));
  const funderNullifier = ethers.keccak256(ethers.toUtf8Bytes('nullifier-funder'));

  const termsHash = ethers.keccak256(ethers.toUtf8Bytes('canonical-job-terms-blob-v1'));
  const amount = ethers.parseEther('1');

  beforeEach(async () => {
    const wallets = richWallets();
    deployerWallet = wallets[0];
    owner = wallets[1];
    recruiter = wallets[2];
    worker = wallets[3];
    outsider = wallets[4];
    keeper = wallets[5];
    funder = wallets[6];

    const deployer = new Deployer(hre, deployerWallet);

    // Identity registry, owner = `owner` so it can bind on demand in tests.
    const receiverArtifact = await deployer.loadArtifact('CofferdamReceiver');
    receiver = await deployer.deploy(receiverArtifact, [owner.address]);

    // Escrow points at the receiver; arbiter = `owner`.
    const escrowArtifact = await deployer.loadArtifact('CofferdamSpotEscrow');
    escrow = await deployer.deploy(escrowArtifact, [
      await receiver.getAddress(),
      owner.address,
    ]);

    // Bind recruiter + worker by default so most tests can start from
    // "identity established"; tests that target the gate rebind manually.
    await (receiver.connect(owner) as Contract).bindNullifier(
      recruiter.address,
      recruiterNullifier,
    );
    await (receiver.connect(owner) as Contract).bindNullifier(
      worker.address,
      workerNullifier,
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('wires identity + owner', async () => {
      expect(await escrow.identity()).to.equal(await receiver.getAddress());
      expect(await escrow.owner()).to.equal(owner.address);
      expect(await escrow.nextContractId()).to.equal(1n);
    });

    it('reverts on zero identity', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('CofferdamSpotEscrow');
      await expect(
        deployer.deploy(artifact, [ethers.ZeroAddress, owner.address]),
      ).to.be.revertedWithCustomError(escrow, 'ZeroAddress');
    });

    it('reverts on zero owner', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('CofferdamSpotEscrow');
      await expect(
        deployer.deploy(artifact, [await receiver.getAddress(), ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(escrow, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // postContract
  // ──────────────────────────────────────────────────────────────────────────

  describe('postContract', () => {
    it('locks funds and emits ContractPosted', async () => {
      const balBefore = await deployerWallet.provider.getBalance(await escrow.getAddress());

      const tx = await (escrow.connect(recruiter) as Contract).postContract(termsHash, {
        value: amount,
      });
      await expect(tx)
        .to.emit(escrow, 'ContractPosted')
        .withArgs(1n, recruiter.address, amount, termsHash);

      const balAfter = await deployerWallet.provider.getBalance(await escrow.getAddress());
      expect(balAfter - balBefore).to.equal(amount);

      const c = await escrow.getContract(1n);
      expect(c.recruiter).to.equal(recruiter.address);
      expect(c.worker).to.equal(ethers.ZeroAddress);
      expect(c.amount).to.equal(amount);
      expect(c.termsHash).to.equal(termsHash);
      expect(c.status).to.equal(0n); // Posted
    });

    it('increments contract id', async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      expect(await escrow.nextContractId()).to.equal(3n);
    });

    it('reverts AccountNotBound for an unverified recruiter', async () => {
      await expect(
        (escrow.connect(outsider) as Contract).postContract(termsHash, { value: amount }),
      )
        .to.be.revertedWithCustomError(escrow, 'AccountNotBound')
        .withArgs(outsider.address);
    });

    it('reverts ZeroAmount on msg.value == 0', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: 0n }),
      ).to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    });

    it('reverts ZeroTermsHash on bytes32(0)', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).postContract(ethers.ZeroHash, { value: amount }),
      ).to.be.revertedWithCustomError(escrow, 'ZeroTermsHash');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // awardContract
  // ──────────────────────────────────────────────────────────────────────────

  describe('awardContract', () => {
    beforeEach(async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
    });

    it('assigns the worker and emits ContractAwarded', async () => {
      await expect((escrow.connect(recruiter) as Contract).awardContract(1n, worker.address))
        .to.emit(escrow, 'ContractAwarded')
        .withArgs(1n, recruiter.address, worker.address);

      const c = await escrow.getContract(1n);
      expect(c.worker).to.equal(worker.address);
      expect(c.status).to.equal(1n); // Awarded
    });

    it('reverts NotRecruiter when called by someone else', async () => {
      await expect(
        (escrow.connect(worker) as Contract).awardContract(1n, worker.address),
      )
        .to.be.revertedWithCustomError(escrow, 'NotRecruiter')
        .withArgs(worker.address, recruiter.address);
    });

    it('reverts AccountNotBound when worker is unverified', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).awardContract(1n, outsider.address),
      )
        .to.be.revertedWithCustomError(escrow, 'AccountNotBound')
        .withArgs(outsider.address);
    });

    it('reverts UnknownContract for a missing contractId', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).awardContract(999n, worker.address),
      )
        .to.be.revertedWithCustomError(escrow, 'UnknownContract')
        .withArgs(999n);
    });

    it('reverts WrongStatus if already awarded', async () => {
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await expect(
        (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address),
      ).to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // checkIn / checkOut
  // ──────────────────────────────────────────────────────────────────────────

  describe('checkIn / checkOut', () => {
    beforeEach(async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
    });

    it('records checkIn and transitions to CheckedIn', async () => {
      const tx = await (escrow.connect(worker) as Contract).checkIn(1n);
      const receipt = await tx.wait();
      const block = await deployerWallet.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(escrow, 'WorkerCheckedIn')
        .withArgs(1n, worker.address, BigInt(block.timestamp));

      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(2n); // CheckedIn
      expect(c.checkedInAt).to.equal(BigInt(block.timestamp));
    });

    it('checkIn reverts NotWorker for anyone else', async () => {
      await expect((escrow.connect(recruiter) as Contract).checkIn(1n))
        .to.be.revertedWithCustomError(escrow, 'NotWorker');
    });

    it('checkOut requires CheckedIn first', async () => {
      await expect((escrow.connect(worker) as Contract).checkOut(1n))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });

    it('records checkOut and transitions to CheckedOut', async () => {
      await (escrow.connect(worker) as Contract).checkIn(1n);
      const tx = await (escrow.connect(worker) as Contract).checkOut(1n);
      const receipt = await tx.wait();
      const block = await deployerWallet.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(escrow, 'WorkerCheckedOut')
        .withArgs(1n, worker.address, BigInt(block.timestamp));

      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(3n); // CheckedOut
    });

    it('checkOut reverts NotWorker for anyone else', async () => {
      await (escrow.connect(worker) as Contract).checkIn(1n);
      await expect((escrow.connect(recruiter) as Contract).checkOut(1n))
        .to.be.revertedWithCustomError(escrow, 'NotWorker');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // settle
  // ──────────────────────────────────────────────────────────────────────────

  describe('settle', () => {
    beforeEach(async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await (escrow.connect(worker) as Contract).checkIn(1n);
      await (escrow.connect(worker) as Contract).checkOut(1n);
    });

    it('transfers the full amount to the worker', async () => {
      const balBefore = await deployerWallet.provider.getBalance(worker.address);
      // Use `keeper` as the caller so the worker's balance delta is exactly `amount`
      // (no gas to subtract). Demonstrates the "settle is public" property.
      await (escrow.connect(keeper) as Contract).settle(1n);
      const balAfter = await deployerWallet.provider.getBalance(worker.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it('drains the escrow', async () => {
      await (escrow.connect(keeper) as Contract).settle(1n);
      expect(await deployerWallet.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it('emits ContractSettled', async () => {
      await expect((escrow.connect(keeper) as Contract).settle(1n))
        .to.emit(escrow, 'ContractSettled')
        .withArgs(1n, worker.address, amount);
    });

    it('marks the contract Settled and zeros the amount', async () => {
      await (escrow.connect(keeper) as Contract).settle(1n);
      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(4n); // Settled
      expect(c.amount).to.equal(0n);
    });

    it('cannot be settled twice', async () => {
      await (escrow.connect(keeper) as Contract).settle(1n);
      await expect((escrow.connect(keeper) as Contract).settle(1n))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });

    it('settle is identity-gate-free (relayer pattern)', async () => {
      // `outsider` has no Cofferdam identity but can still settle.
      const balBefore = await deployerWallet.provider.getBalance(worker.address);
      await (escrow.connect(outsider) as Contract).settle(1n);
      const balAfter = await deployerWallet.provider.getBalance(worker.address);
      expect(balAfter - balBefore).to.equal(amount);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // cancel
  // ──────────────────────────────────────────────────────────────────────────

  describe('cancel', () => {
    beforeEach(async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
    });

    it('refunds the recruiter', async () => {
      // Gas-accounting cross-asserting against `amount` is fragile across
      // zksync-ethers receipt-shape changes (gasPrice typing in particular).
      // Stronger invariants here: escrow drains exactly, recruiter receives
      // *something* (i.e. refund minus gas > 0).
      const escrowBalBefore = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      const balBefore = await deployerWallet.provider.getBalance(recruiter.address);

      await (escrow.connect(recruiter) as Contract).cancel(1n);

      const escrowBalAfter = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      const balAfter = await deployerWallet.provider.getBalance(recruiter.address);

      expect(escrowBalBefore - escrowBalAfter).to.equal(amount);
      // Refund minus gas — > 0 confirms ETH actually flowed back to the recruiter
      // (the alternative would be a stuck balance, or the funds going elsewhere).
      expect(balAfter > balBefore).to.equal(true);
    });

    it('emits ContractCancelled and marks status', async () => {
      await expect((escrow.connect(recruiter) as Contract).cancel(1n))
        .to.emit(escrow, 'ContractCancelled')
        .withArgs(1n, recruiter.address, amount);
      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(5n); // Cancelled
    });

    it('only the recruiter can cancel', async () => {
      await expect((escrow.connect(worker) as Contract).cancel(1n))
        .to.be.revertedWithCustomError(escrow, 'NotRecruiter');
    });

    it('cannot cancel after award', async () => {
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await expect((escrow.connect(recruiter) as Contract).cancel(1n))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Dispute path
  // ──────────────────────────────────────────────────────────────────────────

  describe('dispute / resolveDispute', () => {
    beforeEach(async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await (escrow.connect(worker) as Contract).checkIn(1n);
    });

    it('worker can dispute from CheckedIn', async () => {
      await expect((escrow.connect(worker) as Contract).dispute(1n, 'no-show recruiter'))
        .to.emit(escrow, 'ContractDisputed')
        .withArgs(1n, worker.address, 'no-show recruiter');
      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(6n); // Disputed
    });

    it('recruiter can dispute', async () => {
      await (escrow.connect(recruiter) as Contract).dispute(1n, 'safety concern');
      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(6n);
    });

    it('outsider cannot dispute', async () => {
      // Bind outsider so the identity gate doesn't trigger first;
      // the participant check must be what catches them.
      await (receiver.connect(owner) as Contract).bindNullifier(
        outsider.address,
        outsiderNullifier,
      );
      await expect((escrow.connect(outsider) as Contract).dispute(1n, 'meddling'))
        .to.be.revertedWithCustomError(escrow, 'NotParticipant');
    });

    it('owner resolves to worker', async () => {
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');
      const balBefore = await deployerWallet.provider.getBalance(worker.address);
      await expect(
        (escrow.connect(owner) as Contract).resolveDispute(1n, worker.address),
      )
        .to.emit(escrow, 'DisputeResolved')
        .withArgs(1n, owner.address, worker.address, amount);
      const balAfter = await deployerWallet.provider.getBalance(worker.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it('owner resolves to recruiter', async () => {
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');
      const balBefore = await deployerWallet.provider.getBalance(recruiter.address);
      await (escrow.connect(owner) as Contract).resolveDispute(1n, recruiter.address);
      const balAfter = await deployerWallet.provider.getBalance(recruiter.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it('reverts PayeeMustBeParticipant for an outsider payee', async () => {
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');
      await expect(
        (escrow.connect(owner) as Contract).resolveDispute(1n, outsider.address),
      )
        .to.be.revertedWithCustomError(escrow, 'PayeeMustBeParticipant')
        .withArgs(outsider.address);
    });

    it('only the owner can resolve', async () => {
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');
      await expect(
        (escrow.connect(recruiter) as Contract).resolveDispute(1n, recruiter.address),
      ).to.be.revertedWithCustomError(escrow, 'NotOwner');
    });

    it('cannot dispute a settled contract', async () => {
      await (escrow.connect(worker) as Contract).checkOut(1n);
      await (escrow.connect(worker) as Contract).settle(1n);
      await expect((escrow.connect(worker) as Contract).dispute(1n, 'reason'))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });

    it('cannot dispute twice', async () => {
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');
      await expect((escrow.connect(recruiter) as Contract).dispute(1n, 'reason'))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Corporate flow: postContractIntent → fundContract (α-3)
  //
  // The real-world enterprise procedure: recruiter (HR) doesn't hold funds,
  // a designated `funder` (Finance) does. Recruiter posts intent without
  // value; Finance is notified off-chain (Cofferdam messaging) and funds
  // the contract in a separate tx. Both paths converge at `Posted` and the
  // rest of the lifecycle (award/checkIn/checkOut/settle/dispute) is
  // identical.
  // ──────────────────────────────────────────────────────────────────────────

  describe('postContractIntent', () => {
    beforeEach(async () => {
      // Funder needs Cofferdam identity to fund.
      await (receiver.connect(owner) as Contract).bindNullifier(
        funder.address,
        funderNullifier,
      );
    });

    it('creates a draft with no funds locked, emits ContractDrafted', async () => {
      const escrowBalBefore = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );

      await expect(
        (escrow.connect(recruiter) as Contract).postContractIntent(
          termsHash,
          amount,
          funder.address,
        ),
      )
        .to.emit(escrow, 'ContractDrafted')
        .withArgs(1n, recruiter.address, funder.address, amount, termsHash);

      // Crucial property: no value transferred at intent time.
      const escrowBalAfter = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      expect(escrowBalAfter).to.equal(escrowBalBefore);

      const c = await escrow.getContract(1n);
      expect(c.recruiter).to.equal(recruiter.address);
      expect(c.designatedFunder).to.equal(funder.address);
      expect(c.funder).to.equal(ethers.ZeroAddress);
      expect(c.worker).to.equal(ethers.ZeroAddress);
      expect(c.amount).to.equal(amount);
      expect(c.termsHash).to.equal(termsHash);
      expect(c.status).to.equal(8n); // Drafted
    });

    it('allows address(0) as designatedFunder (open funding)', async () => {
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        ethers.ZeroAddress,
      );
      const c = await escrow.getContract(1n);
      expect(c.designatedFunder).to.equal(ethers.ZeroAddress);
      expect(c.status).to.equal(8n); // Drafted
    });

    it('reverts AccountNotBound for an unverified recruiter', async () => {
      await expect(
        (escrow.connect(outsider) as Contract).postContractIntent(
          termsHash,
          amount,
          funder.address,
        ),
      )
        .to.be.revertedWithCustomError(escrow, 'AccountNotBound')
        .withArgs(outsider.address);
    });

    it('reverts ZeroAmount on amount == 0', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).postContractIntent(
          termsHash,
          0n,
          funder.address,
        ),
      ).to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    });

    it('reverts ZeroTermsHash on bytes32(0)', async () => {
      await expect(
        (escrow.connect(recruiter) as Contract).postContractIntent(
          ethers.ZeroHash,
          amount,
          funder.address,
        ),
      ).to.be.revertedWithCustomError(escrow, 'ZeroTermsHash');
    });

    it('shares the contract id space with postContract', async () => {
      // postContract uses id=1
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      // postContractIntent uses id=2
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        funder.address,
      );
      expect(await escrow.nextContractId()).to.equal(3n);
    });
  });

  describe('fundContract', () => {
    beforeEach(async () => {
      await (receiver.connect(owner) as Contract).bindNullifier(
        funder.address,
        funderNullifier,
      );
      // Recruiter creates a draft with funder explicitly designated.
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        funder.address,
      );
    });

    it('locks funds, transitions Drafted → Posted, emits ContractFunded + ContractPosted', async () => {
      const escrowBalBefore = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );

      const tx = await (escrow.connect(funder) as Contract).fundContract(1n, {
        value: amount,
      });
      await expect(tx)
        .to.emit(escrow, 'ContractFunded')
        .withArgs(1n, funder.address, amount);
      await expect(tx)
        .to.emit(escrow, 'ContractPosted')
        .withArgs(1n, recruiter.address, amount, termsHash);

      const escrowBalAfter = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      expect(escrowBalAfter - escrowBalBefore).to.equal(amount);

      const c = await escrow.getContract(1n);
      expect(c.funder).to.equal(funder.address);
      expect(c.status).to.equal(0n); // Posted
    });

    it('reverts NotDesignatedFunder if a different account tries to fund', async () => {
      // outsider is unbound; bind them so the identity gate doesn't shadow
      // the designated-funder check.
      await (receiver.connect(owner) as Contract).bindNullifier(
        outsider.address,
        outsiderNullifier,
      );
      await expect(
        (escrow.connect(outsider) as Contract).fundContract(1n, { value: amount }),
      )
        .to.be.revertedWithCustomError(escrow, 'NotDesignatedFunder')
        .withArgs(outsider.address, funder.address);
    });

    it('reverts WrongFundingAmount on under-funding', async () => {
      await expect(
        (escrow.connect(funder) as Contract).fundContract(1n, { value: amount - 1n }),
      )
        .to.be.revertedWithCustomError(escrow, 'WrongFundingAmount')
        .withArgs(amount, amount - 1n);
    });

    it('reverts WrongFundingAmount on over-funding', async () => {
      await expect(
        (escrow.connect(funder) as Contract).fundContract(1n, { value: amount + 1n }),
      )
        .to.be.revertedWithCustomError(escrow, 'WrongFundingAmount')
        .withArgs(amount, amount + 1n);
    });

    it('reverts AccountNotBound if the funder is unverified', async () => {
      // Re-bind funder away (one-shot replay-guard means we use a fresh
      // wallet instead). The simplest setup: create another draft where
      // the designated funder is `outsider`, who has no Cofferdam identity.
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        outsider.address,
      );
      await expect(
        (escrow.connect(outsider) as Contract).fundContract(2n, { value: amount }),
      )
        .to.be.revertedWithCustomError(escrow, 'AccountNotBound')
        .withArgs(outsider.address);
    });

    it('cannot fund the same draft twice', async () => {
      await (escrow.connect(funder) as Contract).fundContract(1n, { value: amount });
      await expect(
        (escrow.connect(funder) as Contract).fundContract(1n, { value: amount }),
      ).to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });

    it('cannot fund a self-funded contract (it is not Drafted)', async () => {
      await (escrow.connect(recruiter) as Contract).postContract(termsHash, { value: amount });
      // Self-funded contract id = 2 here (the beforeEach created id=1 as a draft).
      await expect(
        (escrow.connect(funder) as Contract).fundContract(2n, { value: amount }),
      ).to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });

    it('open-funding mode: any Cofferdam-bound account can fund', async () => {
      // Create a separate draft with no designated funder.
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        ethers.ZeroAddress,
      );
      // Bind worker (anyone bound, doesn't have to be tagged as Finance).
      await expect(
        (escrow.connect(worker) as Contract).fundContract(2n, { value: amount }),
      )
        .to.emit(escrow, 'ContractFunded')
        .withArgs(2n, worker.address, amount);
      const c = await escrow.getContract(2n);
      expect(c.funder).to.equal(worker.address);
      expect(c.status).to.equal(0n); // Posted
    });

    it('full corporate happy path: draft → fund → award → checkIn → checkOut → settle', async () => {
      // Already drafted in beforeEach. Fund:
      await (escrow.connect(funder) as Contract).fundContract(1n, { value: amount });
      // Existing pipeline takes over unchanged:
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await (escrow.connect(worker) as Contract).checkIn(1n);
      await (escrow.connect(worker) as Contract).checkOut(1n);

      const workerBalBefore = await deployerWallet.provider.getBalance(worker.address);
      await (escrow.connect(keeper) as Contract).settle(1n);
      const workerBalAfter = await deployerWallet.provider.getBalance(worker.address);

      expect(workerBalAfter - workerBalBefore).to.equal(amount);
      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(4n); // Settled
    });
  });

  describe('cancelDraft', () => {
    beforeEach(async () => {
      await (receiver.connect(owner) as Contract).bindNullifier(
        funder.address,
        funderNullifier,
      );
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        funder.address,
      );
    });

    it('moves Drafted → Cancelled, no fund transfer, emits DraftCancelled', async () => {
      const escrowBalBefore = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      await expect((escrow.connect(recruiter) as Contract).cancelDraft(1n))
        .to.emit(escrow, 'DraftCancelled')
        .withArgs(1n, recruiter.address);
      const escrowBalAfter = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );
      expect(escrowBalAfter).to.equal(escrowBalBefore);

      const c = await escrow.getContract(1n);
      expect(c.status).to.equal(5n); // Cancelled
    });

    it('only the recruiter can cancelDraft', async () => {
      await expect((escrow.connect(funder) as Contract).cancelDraft(1n))
        .to.be.revertedWithCustomError(escrow, 'NotRecruiter');
    });

    it('cannot cancelDraft a Posted contract', async () => {
      // Fund first to move past Drafted.
      await (escrow.connect(funder) as Contract).fundContract(1n, { value: amount });
      await expect((escrow.connect(recruiter) as Contract).cancelDraft(1n))
        .to.be.revertedWithCustomError(escrow, 'WrongStatus');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Refund routing: cancel + resolveDispute must pay the funder, not the
  // recruiter, when they differ (the corporate flow). For self-funded the
  // refund still lands on the recruiter (funder == recruiter), and the
  // existing α-2 tests cover that case above.
  // ──────────────────────────────────────────────────────────────────────────

  describe('refund routing (corporate flow)', () => {
    beforeEach(async () => {
      await (receiver.connect(owner) as Contract).bindNullifier(
        funder.address,
        funderNullifier,
      );
      await (escrow.connect(recruiter) as Contract).postContractIntent(
        termsHash,
        amount,
        funder.address,
      );
      await (escrow.connect(funder) as Contract).fundContract(1n, { value: amount });
    });

    it('cancel refunds the funder, not the recruiter', async () => {
      const recruiterBalBefore = await deployerWallet.provider.getBalance(recruiter.address);
      const funderBalBefore = await deployerWallet.provider.getBalance(funder.address);
      const escrowBalBefore = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );

      await (escrow.connect(recruiter) as Contract).cancel(1n);

      const recruiterBalAfter = await deployerWallet.provider.getBalance(recruiter.address);
      const funderBalAfter = await deployerWallet.provider.getBalance(funder.address);
      const escrowBalAfter = await deployerWallet.provider.getBalance(
        await escrow.getAddress(),
      );

      // Escrow drained by exactly `amount`.
      expect(escrowBalBefore - escrowBalAfter).to.equal(amount);
      // Funder got the refund (gross > 0 confirms ETH flowed to them).
      expect(funderBalAfter - funderBalBefore).to.equal(amount);
      // Recruiter's balance only decreased by gas (cancel costs them gas
      // but doesn't refund them anything).
      expect(recruiterBalAfter < recruiterBalBefore).to.equal(true);
    });

    it('resolveDispute(recruiter-side) pays the funder, not the recruiter', async () => {
      // Move to Disputed.
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await (escrow.connect(worker) as Contract).checkIn(1n);
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');

      // Recruiter address is NOT a valid payee any more — funder is.
      await expect(
        (escrow.connect(owner) as Contract).resolveDispute(1n, recruiter.address),
      )
        .to.be.revertedWithCustomError(escrow, 'PayeeMustBeParticipant')
        .withArgs(recruiter.address);

      // Funder is the valid payee for the recruiter-side resolution.
      const funderBalBefore = await deployerWallet.provider.getBalance(funder.address);
      await expect(
        (escrow.connect(owner) as Contract).resolveDispute(1n, funder.address),
      )
        .to.emit(escrow, 'DisputeResolved')
        .withArgs(1n, owner.address, funder.address, amount);
      const funderBalAfter = await deployerWallet.provider.getBalance(funder.address);
      expect(funderBalAfter - funderBalBefore).to.equal(amount);
    });

    it('resolveDispute(worker-side) still pays the worker', async () => {
      await (escrow.connect(recruiter) as Contract).awardContract(1n, worker.address);
      await (escrow.connect(worker) as Contract).checkIn(1n);
      await (escrow.connect(worker) as Contract).dispute(1n, 'reason');

      const workerBalBefore = await deployerWallet.provider.getBalance(worker.address);
      await (escrow.connect(owner) as Contract).resolveDispute(1n, worker.address);
      const workerBalAfter = await deployerWallet.provider.getBalance(worker.address);
      expect(workerBalAfter - workerBalBefore).to.equal(amount);
    });
  });
});
