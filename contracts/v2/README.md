# v2/ — ZKSync-native Self deployment (preserved foundation)

**Status: parked, contingent on Self.xyz deploying their full contract suite on ZKSync Era natively.**

## What's in here

The on-chain Groth16 verification stack we built in Phase 0 + Phase 1 (first slice), preserved as the foundation for a future ZKSync-native Self integration.

```
v2/self/
├── Verifier_vc_and_disclose.sol   # Self's Groth16 verifier (forked, zksolc-compiled)
├── ISelfGroth16Verifier.sol       # Interface for the above
├── SelfPublicSignals.sol          # Public signal index constants + E_PASSPORT_ATTESTATION_ID
├── SelfAttesterRegistry.sol       # Two-step-ownable allow-list of trusted attester ECDSA keys
├── NullifierRegistry.sol          # One-shot account ↔ nullifier binding with proof + attester sig verification
└── mocks/
    └── MockSelfGroth16Verifier.sol  # Test fixture
```

## Why preserve it

A ZKSync-native Self deployment would require Self.xyz to:

1. Deploy `IdentityVerificationHubImplV2` + `CustomVerifier` on ZKSync Era
2. Deploy `IdentityRegistryImplV1` (the merkle tree) + dual-publish merkle root updates from Celo (or run a separate ZKSync-side registration flow)
3. Deploy ~30 `Verifier_register_id_*` circuit verifiers (one per supported certificate chain: RSA-4096, ECDSA-secp256r1, brainpoolP384r1, etc.)
4. Update their TEE registration flow to know about ZKSync as a destination chain
5. Update their mobile SDK to scope proofs for ZKSync's chain ID

That's a 3-6 month roadmap item on Self's side and entirely outside our control. **But** if and when they ship it, we can repurpose the work in `v2/self/`:

- `Verifier_vc_and_disclose.sol` already deployed to ZKSync Era Sepolia at [`0xf23537eF06fC1283F5be80676418b71aEd81b7E5`](https://sepolia.explorer.zksync.io/address/0xf23537eF06fC1283F5be80676418b71aEd81b7E5). Proves BN254 precompiles work on ZKSync Era — useful as a builder-bounty contribution.
- `NullifierRegistry.sol` is already the structural skeleton of a ZKSync-native Self consumer (validates proof + scope + attestation ID + user identifier + binds nullifier).
- `SelfAttesterRegistry.sol` becomes immediately useful if Self ever exposes an *"attest over `(merkle_root, timestamp)`"* primitive, which would allow us to gate proofs on a trusted merkle root snapshot.

## Why this is parked (and not deleted)

- **37 passing unit tests** (23 for `SelfAttesterRegistry`, 14 for `NullifierRegistry`) — institutional knowledge of the verification flow encoded as executable specs.
- **Deployment on ZKSync Era Sepolia** (Phase 0) is live and useful as a proof-point in conversations with Self / Matter Labs.
- **Compilation budget** is near zero — these contracts are small.
- **Optionality**: if anything changes on Self's roadmap, we don't have to rewrite from scratch.

## What v2/ is *not*

- Not active development for Phase 1.
- Not deployed in the v1 LayerZero hybrid flow (Self handles verification on Celo there).
- Not the canonical identity registry — `v1/zksync/OffshoreSyncReceiver` is.

## Future work

When Self ships native ZKSync Era:

1. Wire `NullifierRegistry` to use Self's deployed `IdentityVerificationHubImplV2` on ZKSync directly (drop our local `Verifier_vc_and_disclose` deploy, use theirs).
2. Add a merkle-root trust mechanism (either mirror Self's `IdentityRegistry` or trust their hub's root checks).
3. Drop the LayerZero hop entirely — verification + settlement on the same chain.

Until then: `v2/` sits patient, fully tested, ready.
