// Test-only helpers for the CofferdamAccount authority framework.
//
// Reproduces the on-chain signature-binding scheme (CofferdamAccount._digest)
// and the two concrete authority signature shapes:
//   - PasskeyAuthority  : raw P-256 (r||s, low-s) over the digest.
//   - SessionKeyAuthority: EIP-191 personal_sign over keccak256(account, digest).

import { p256 } from '@noble/curves/p256';
import { ethers } from 'ethers';

const abi = ethers.AbiCoder.defaultAbiCoder();

// Tags must match the constants in CofferdamAccount.sol exactly.
export const TAG = {
  execute: ethers.id('CofferdamAccount.execute'),
  executeBatch: ethers.id('CofferdamAccount.executeBatch'),
  addAuthority: ethers.id('CofferdamAccount.addAuthority'),
  revokeAuthority: ethers.id('CofferdamAccount.revokeAuthority'),
  enrollFirstPasskey: ethers.id('CofferdamAccount.enrollFirstPasskey'),
};

/** Reproduce CofferdamAccount._digest(tag, payload). */
export function accountDigest(
  account: string,
  chainId: bigint,
  nonce: bigint,
  tag: string,
  payload: string,
): string {
  return ethers.keccak256(
    abi.encode(
      ['address', 'uint256', 'uint256', 'bytes32', 'bytes'],
      [account, chainId, nonce, tag, payload],
    ),
  );
}

export function executePayload(target: string, value: bigint, data: string): string {
  return abi.encode(['address', 'uint256', 'bytes32'], [target, value, ethers.keccak256(data)]);
}

export function moduleConfigPayload(moduleAddr: string, config: string): string {
  return abi.encode(['address', 'bytes32'], [moduleAddr, ethers.keccak256(config)]);
}

export function revokePayload(targetId: bigint): string {
  return abi.encode(['uint256'], [targetId]);
}

// ── P-256 passkey ─────────────────────────────────────────────────────────────

export interface P256Key {
  priv: Uint8Array;
  qx: string; // 0x-prefixed 32-byte hex
  qy: string;
  config: string; // abi.encode(qx, qy)
}

export function generateP256Key(): P256Key {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false); // 0x04 || x(32) || y(32)
  const qx = ethers.hexlify(pub.slice(1, 33));
  const qy = ethers.hexlify(pub.slice(33, 65));
  const config = abi.encode(['bytes32', 'bytes32'], [qx, qy]);
  return { priv, qx, qy, config };
}

/** Sign a 32-byte digest with P-256, returning 64-byte r||s with enforced
 *  low-s. OZ `P256.verify` rejects s > N/2 (EIP-2 malleability guard), and this
 *  noble build does not normalize s by default, so we do it explicitly. */
export function signP256(priv: Uint8Array, digest: string): string {
  const sig = p256.sign(ethers.getBytes(digest), priv);
  const n = p256.CURVE.n;
  let sVal = sig.s;
  if (sVal > n / 2n) sVal = n - sVal;
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sVal.toString(16).padStart(64, '0');
  return '0x' + r + s;
}

// ── Session key (legacy bridge) ─────────────────────────────────────────────

export function sessionConfig(signer: string): string {
  return abi.encode(['address'], [signer]);
}

/** Produce a SessionKeyAuthority signature: personal_sign(keccak256(account,digest)). */
export async function signSession(
  signer: ethers.HDNodeWallet | ethers.Wallet,
  account: string,
  digest: string,
): Promise<string> {
  const bound = ethers.keccak256(abi.encode(['address', 'bytes32'], [account, digest]));
  return signer.signMessage(ethers.getBytes(bound));
}
