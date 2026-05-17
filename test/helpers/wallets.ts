// Test-only helper. Returns multiple prefunded anvil-zksync wallets connected
// to the local L2 provider, plus a freshly-instantiated zksync-ethers
// `Provider` (we don't reuse `hre.ethers.provider` because the matter-labs
// plugin returns a provider that's missing `getGasPrice`, which zksync-ethers'
// Wallet still calls during tx population).
//
// We can't rely on `hre.ethers.getWallets()` because our `inMemoryNode`
// network is configured with a single private key (the deployer) — tests
// need fresh, distinct accounts (owner / other / etc.).
//
// The keys below are anvil-zksync's "rich wallets" — every cold start of the
// node prefunds them with 10000 ETH. They are PUBLIC test keys; never send
// real funds to them. Keys lifted from
// `node_modules/@matterlabs/hardhat-zksync-ethers/dist/rich-wallets.js`.

import * as hre from 'hardhat';
import { Wallet, Provider } from 'zksync-ethers';

const RICH_WALLET_PKS: string[] = [
  '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
  '0x509ca2e9e6acf0ba086477910950125e698d4ea70fa6f63e000c5a22bda9361c',
  '0x71781d3a358e7a65150e894264ccc594993fbc0ea12d69508a340bc1d4f5bfbc',
  '0x379d31d4a7031ead87397f332aab69ef5cd843ba3898249ca1046633c0c7eefe',
  '0x105de4e75fe465d075e1daae5647a02e3aad54b8d23cf1f70ba382b9f9bee839',
  '0x7becc4a46e0c3b512d380ca73a4c868f790d1055a7698f38fb3ca2b2ac97efbb',
  '0xe0415469c10f3b1142ce0262497fe5c7a0795f0cbfd466a6bfa31968d0f70841',
  '0x4d91647d0a8429ac4433c83254fb9625332693c848e578062fe96362f32bfe91',
  '0x41c9f9518aa07b50cb1c0cc160d45547f57638dd824a8d85b5eb3bf99ed2bdeb',
  '0xb0680d66303a0163a19294f1ef8c95cd69a9d7902a4aca99c05f3e134e68a11a',
];

/// @returns A fresh zksync-ethers `Provider` pointed at the network this test
///          run is configured for. Avoids the `getGasPrice is not a function`
///          error you get from passing `hre.ethers.provider` into a
///          zksync-ethers `Wallet`.
export function testProvider(): Provider {
  const url = (hre.network.config as any).url as string;
  if (!url) throw new Error(`Network ${hre.network.name} has no RPC url configured`);
  return new Provider(url);
}

export function richWallets(provider?: Provider): Wallet[] {
  const p = provider ?? testProvider();
  return RICH_WALLET_PKS.map((pk) => new Wallet(pk, p));
}
