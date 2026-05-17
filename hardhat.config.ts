import { HardhatUserConfig } from 'hardhat/config';
import '@matterlabs/hardhat-zksync';
import '@nomicfoundation/hardhat-chai-matchers';
import 'dotenv/config';

// ──────────────────────────────────────────────────────────────────────────────
// OffshoreSync — ZKSync Era contracts (Phase 0 spike)
// Goal: prove that Self.xyz's snarkjs-generated Groth16 verifier compiles
// cleanly under zksolc and deploys successfully on ZKSync Era Sepolia.
// ──────────────────────────────────────────────────────────────────────────────

const PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ||
  // Dummy key (Hardhat default account #0) — never used for testnet/mainnet,
  // only present so `hardhat` can boot without DEPLOYER_PRIVATE_KEY in CI/local.
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const config: HardhatUserConfig = {
  defaultNetwork: 'zkSyncSepolia',

  // Standard solc settings (used as input to zksolc).
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  // zksolc compiler settings. zksolc consumes the solc output above and
  // transpiles to zkEVM bytecode. We pin a known-good zksolc version so
  // Phase 0 results are reproducible.
  //
  // NOTE: the plugin's auto-downloader is currently broken on undici v6
  // (it still uses the removed `maxRedirections` option). We sidestep it
  // by vendoring the binary at ./bin/zksolc — see README for the curl
  // command. When matter-labs ships a fix, this `compilerPath` line can
  // be removed.
  zksolc: {
    // `version` is intentionally omitted — when `compilerPath` is set,
    // the plugin requires us to NOT specify a version (the binary's own
    // version is the source of truth). Currently pinned at 1.5.16 via
    // the curl command in README.md.
    settings: {
      compilerPath: './bin/zksolc',
      // Explicitly select the Yul codegen (zksolc's current default).
      // Setting this silences a deprecation warning and future-proofs us:
      // zksolc has signaled that omitting `codegen` will become a hard
      // error. `yul` is also the right choice for heavy-math contracts
      // like Groth16 verifiers (no recursion, no internal fn pointers).
      codegen: 'yul',
      optimizer: {
        enabled: true,
        mode: '3', // -O3 equivalent
      },
    },
  },

  // anvil-zksync (in-memory ZKSync Era node) configuration.
  // Same vendoring story as zksolc: the plugin's auto-downloader uses the
  // removed undici `maxRedirections` API. We point at a vendored binary
  // (see README for the curl command) so the download path is skipped.
  zksyncAnvil: {
    binaryPath: './bin/anvil-zksync',
  },

  networks: {
    // EVM-side local network (sanity-check that the contract compiles & deploys
    // on stock EVM before we ask zksolc the same question).
    hardhat: {
      zksync: false,
    },

    // Local in-memory ZKSync Era node (anvil-zksync).
    // Launched by `yarn node:start` — listens on http://127.0.0.1:8011 by default.
    // The account below is anvil-zksync's "rich wallet #0" — derived from
    // the standard Anvil test mnemonic
    //   "test test test test test test test test test test test junk"
    // at path m/44'/60'/0'/0/0 — and gets 10000 prefunded ETH on every cold
    // start. It is a public test key. NEVER use it on a network with real funds.
    inMemoryNode: {
      url: 'http://127.0.0.1:8011',
      ethNetwork: '',
      zksync: true,
      chainId: 260,
      accounts: [
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      ],
    },

    // ZKSync Era Sepolia testnet.
    // RPCs:
    //   https://sepolia.era.zksync.dev          (Matter Labs public)
    //   https://zksync-era-sepolia.public.blastapi.io  (Blast)
    // Block explorer: https://sepolia.explorer.zksync.io
    zkSyncSepolia: {
      url: process.env.ZKSYNC_SEPOLIA_RPC_URL || 'https://sepolia.era.zksync.dev',
      ethNetwork: process.env.ETH_SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
      zksync: true,
      chainId: 300,
      accounts: [PRIVATE_KEY],
      verifyURL: 'https://explorer.sepolia.era.zksync.dev/contract_verification',
    },

    // ZKSync Era mainnet (used post-spike).
    zkSyncMainnet: {
      url: process.env.ZKSYNC_MAINNET_RPC_URL || 'https://mainnet.era.zksync.io',
      ethNetwork: process.env.ETH_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com',
      zksync: true,
      chainId: 324,
      accounts: [PRIVATE_KEY],
      verifyURL: 'https://zksync2-mainnet-explorer.zksync.io/contract_verification',
    },
  },

  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
    // hardhat-zksync-deploy looks here for deploy scripts (default ./deploy).
    deployPaths: 'scripts',
  },
};

export default config;
