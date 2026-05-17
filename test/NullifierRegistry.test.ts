// Unit tests for NullifierRegistry. Covers the happy path plus every revert
// branch in `verifyAndBind`. Uses MockSelfGroth16Verifier so we don't need
// real Groth16 inputs — the verifier's true/false return is the only knob
// the registry actually depends on.

import { expect } from 'chai';
import * as hre from 'hardhat';
import { Wallet, Contract } from 'zksync-ethers';
import { ethers } from 'ethers';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import '@nomicfoundation/hardhat-chai-matchers';

import { richWallets } from './helpers/wallets';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const E_PASSPORT_ATTESTATION_ID = 1n;
const TEST_SCOPE = 0x4f53534fffeen; // 'OSSO\xff\xfe\xee' just a distinctive value

type PubSignalOverrides = {
  account: string;
  nullifier?: bigint;
  scope?: bigint;
  attestationId?: bigint;
  userIdentifier?: bigint; // override pubSignals[20] independently from `account`
};

/// Build a pubSignals[21] array. All fields default to "valid for `account`".
/// Override individual indices to trigger specific revert paths.
function buildPubSignals(o: PubSignalOverrides): bigint[] {
  const arr = new Array<bigint>(21).fill(0n);
  arr[7] = o.nullifier ?? 0xdeadbeefn;
  arr[8] = o.attestationId ?? E_PASSPORT_ATTESTATION_ID;
  arr[19] = o.scope ?? TEST_SCOPE;
  arr[20] = o.userIdentifier ?? BigInt(o.account);
  return arr;
}

const ZERO_PROOF: {
  a: [bigint, bigint];
  b: [[bigint, bigint], [bigint, bigint]];
  c: [bigint, bigint];
} = {
  a: [0n, 0n],
  b: [
    [0n, 0n],
    [0n, 0n],
  ],
  c: [0n, 0n],
};

async function signAttester(
  attester: ethers.HDNodeWallet,
  registry: Contract,
  account: string,
  pubSignals: bigint[],
): Promise<string> {
  const hash: string = await registry.attesterMessageHash(account, pubSignals);
  return attester.signMessage(ethers.getBytes(hash));
}

// ────────────────────────────────────────────────────────────────────────────
// Suite
// ────────────────────────────────────────────────────────────────────────────

describe('NullifierRegistry', () => {
  let deployerWallet: Wallet;
  let aliceAccount: Wallet;
  let bobAccount: Wallet;
  let attester: ethers.HDNodeWallet;
  let untrustedAttester: ethers.HDNodeWallet;

  let mockVerifier: Contract;
  let attesterRegistry: Contract;
  let registry: Contract;

  beforeEach(async () => {
    const wallets = richWallets();
    deployerWallet = wallets[0];
    aliceAccount = wallets[1];
    bobAccount = wallets[2];

    attester = ethers.Wallet.createRandom();
    untrustedAttester = ethers.Wallet.createRandom();

    const deployer = new Deployer(hre, deployerWallet);

    const mockVerifierArtifact = await deployer.loadArtifact('MockSelfGroth16Verifier');
    mockVerifier = await deployer.deploy(mockVerifierArtifact, [true]);

    const attesterRegistryArtifact = await deployer.loadArtifact('SelfAttesterRegistry');
    attesterRegistry = await deployer.deploy(attesterRegistryArtifact, [
      deployerWallet.address,
      [attester.address],
    ]);

    const nullifierRegistryArtifact = await deployer.loadArtifact('NullifierRegistry');
    registry = await deployer.deploy(nullifierRegistryArtifact, [
      await mockVerifier.getAddress(),
      await attesterRegistry.getAddress(),
      // Serialized as string to dodge `Deployer.deploy`'s JSON.stringify cache
      // step which can't handle BigInt. The contract still receives a uint256.
      TEST_SCOPE.toString(),
    ]);
  });

  // ──────────────────────────────────────────────────────────────────────
  describe('constructor', () => {
    it('stores wired dependencies and scope', async () => {
      expect(await registry.verifier()).to.equal(await mockVerifier.getAddress());
      expect(await registry.attesterRegistry()).to.equal(await attesterRegistry.getAddress());
      expect(await registry.expectedScope()).to.equal(TEST_SCOPE);
    });

    it('reverts ZeroAddress when verifier is 0x0', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('NullifierRegistry');
      await expect(
        deployer.deploy(artifact, [
          ethers.ZeroAddress,
          await attesterRegistry.getAddress(),
          TEST_SCOPE.toString(),
        ]),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });

    it('reverts ZeroAddress when attesterRegistry is 0x0', async () => {
      const deployer = new Deployer(hre, deployerWallet);
      const artifact = await deployer.loadArtifact('NullifierRegistry');
      await expect(
        deployer.deploy(artifact, [
          await mockVerifier.getAddress(),
          ethers.ZeroAddress,
          TEST_SCOPE.toString(),
        ]),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  describe('verifyAndBind — happy path', () => {
    it('binds nullifier ↔ account, emits NullifierBound, mock verifier returns true', async () => {
      const account = aliceAccount.address;
      const pub = buildPubSignals({ account });
      const sig = await signAttester(attester, registry, account, pub);

      await expect(registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig))
        .to.emit(registry, 'NullifierBound')
        .withArgs(account, pub[7], E_PASSPORT_ATTESTATION_ID, TEST_SCOPE);

      expect(await registry.nullifierToAccount(pub[7])).to.equal(account);
      expect(await registry.accountToNullifier(account)).to.equal(pub[7]);
      expect(await registry.isAccountBound(account)).to.equal(true);
      expect(await registry.isNullifierBound(pub[7])).to.equal(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  describe('verifyAndBind — revert paths', () => {
    it('ZeroAddress when account is 0x0', async () => {
      const pub = buildPubSignals({ account: ethers.ZeroAddress });
      const sig = await signAttester(attester, registry, ethers.ZeroAddress, pub);
      await expect(
        registry.verifyAndBind(ethers.ZeroAddress, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });

    it('WrongAttestationId when attestationId != E_PASSPORT', async () => {
      const account = aliceAccount.address;
      const pub = buildPubSignals({ account, attestationId: 2n /* EU_ID_CARD */ });
      const sig = await signAttester(attester, registry, account, pub);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      )
        .to.be.revertedWithCustomError(registry, 'WrongAttestationId')
        .withArgs(E_PASSPORT_ATTESTATION_ID, 2n);
    });

    it('WrongScope when proof scope != registry expectedScope', async () => {
      const account = aliceAccount.address;
      const wrongScope = TEST_SCOPE + 1n;
      const pub = buildPubSignals({ account, scope: wrongScope });
      const sig = await signAttester(attester, registry, account, pub);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      )
        .to.be.revertedWithCustomError(registry, 'WrongScope')
        .withArgs(TEST_SCOPE, wrongScope);
    });

    it('UserIdentifierMismatch when pubSignals[20] != account', async () => {
      const account = aliceAccount.address;
      const wrongUser = BigInt(bobAccount.address);
      const pub = buildPubSignals({ account, userIdentifier: wrongUser });
      const sig = await signAttester(attester, registry, account, pub);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      ).to.be.revertedWithCustomError(registry, 'UserIdentifierMismatch');
    });

    it('AccountAlreadyBound when same account binds twice', async () => {
      const account = aliceAccount.address;
      const pub1 = buildPubSignals({ account, nullifier: 0x111n });
      const sig1 = await signAttester(attester, registry, account, pub1);
      await registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub1, sig1);

      const pub2 = buildPubSignals({ account, nullifier: 0x222n });
      const sig2 = await signAttester(attester, registry, account, pub2);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub2, sig2),
      )
        .to.be.revertedWithCustomError(registry, 'AccountAlreadyBound')
        .withArgs(account, 0x111n);
    });

    it('NullifierAlreadyBound when same nullifier binds to different accounts', async () => {
      const nullifier = 0x444n;

      // First bind: alice
      const pubA = buildPubSignals({ account: aliceAccount.address, nullifier });
      const sigA = await signAttester(attester, registry, aliceAccount.address, pubA);
      await registry.verifyAndBind(aliceAccount.address, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pubA, sigA);

      // Second bind: bob, same nullifier — must revert.
      const pubB = buildPubSignals({ account: bobAccount.address, nullifier });
      const sigB = await signAttester(attester, registry, bobAccount.address, pubB);
      await expect(
        registry.verifyAndBind(bobAccount.address, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pubB, sigB),
      )
        .to.be.revertedWithCustomError(registry, 'NullifierAlreadyBound')
        .withArgs(nullifier, aliceAccount.address);
    });

    it('UntrustedAttester when sig is from a non-allowlisted key', async () => {
      const account = aliceAccount.address;
      const pub = buildPubSignals({ account });
      const sig = await signAttester(untrustedAttester, registry, account, pub);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      ).to.be.revertedWithCustomError(registry, 'UntrustedAttester');
    });

    it('InvalidProof when verifier returns false', async () => {
      await mockVerifier.setResult(false);
      const account = aliceAccount.address;
      const pub = buildPubSignals({ account });
      const sig = await signAttester(attester, registry, account, pub);
      await expect(
        registry.verifyAndBind(account, ZERO_PROOF.a, ZERO_PROOF.b, ZERO_PROOF.c, pub, sig),
      ).to.be.revertedWithCustomError(registry, 'InvalidProof');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  describe('attesterMessageHash', () => {
    it('matches off-chain reconstruction (chainId, this, account, pubSignals)', async () => {
      const account = aliceAccount.address;
      const pub = buildPubSignals({ account });
      const onChain: string = await registry.attesterMessageHash(account, pub);

      const chainId = (await registry.runner!.provider!.getNetwork()).chainId;
      const offChain = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'address', 'address', 'uint256[21]'],
          [chainId, await registry.getAddress(), account, pub],
        ),
      );
      expect(onChain).to.equal(offChain);
    });

    it('changes if any pubSignals byte changes', async () => {
      const account = aliceAccount.address;
      const a = buildPubSignals({ account, nullifier: 0x1n });
      const b = buildPubSignals({ account, nullifier: 0x2n });
      const ha: string = await registry.attesterMessageHash(account, a);
      const hb: string = await registry.attesterMessageHash(account, b);
      expect(ha).to.not.equal(hb);
    });
  });
});
