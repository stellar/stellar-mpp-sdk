import { Point } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { randomBytes } from 'node:crypto'
import type { Keypair } from '@stellar/stellar-sdk'
import { GROUP_ORDER, bytesToNumberLE } from './ed25519.js'

/**
 * Test vectors for the strict ed25519 rules in `ed25519.ts`. Each satisfies
 * the cofactored equation but is rejected by the strict check, so tests can
 * assert the strict verdict on concrete inputs rather than through a mock.
 */

/** A canonical encoding of a point of order 8 on the ed25519 curve. */
const TORSION_8 = Point.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')
if (!TORSION_8.isSmallOrder() || TORSION_8.multiply(4n, false).is0()) {
  throw new Error('TORSION_8 is not a point of order 8')
}

function numberToBytesLE(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

/** The RFC 8032 secret scalar of a Stellar keypair, reduced modulo the group order. */
function secretScalar(kp: Keypair): bigint {
  const h = sha512(kp.rawSecretKey()).slice(0, 32)
  h[0] &= 248
  h[31] &= 127
  h[31] |= 64
  return bytesToNumberLE(h) % GROUP_ORDER
}

function randomScalar(): bigint {
  for (;;) {
    const r = bytesToNumberLE(randomBytes(64)) % GROUP_ORDER
    if (r !== 0n) return r
  }
}

function challenge(R: Uint8Array, A: Uint8Array, message: Uint8Array): bigint {
  return bytesToNumberLE(sha512(Buffer.concat([R, A, message]))) % GROUP_ORDER
}

/** Test vector: a signature by `kp` over `message` whose nonce point has an order-8 component. */
export function signWithTorsionedNonce(kp: Keypair, message: Uint8Array): Buffer {
  const a = secretScalar(kp)
  const A = kp.rawPublicKey()
  const r = randomScalar()
  const R = Point.BASE.multiply(r).add(TORSION_8).toBytes()
  const k = challenge(R, A, message)
  const S = (r + k * a) % GROUP_ORDER
  return Buffer.concat([R, numberToBytesLE(S, 32)])
}

/** Test vector: a signature by `kp` over `message` whose nonce point is the identity (small-order). */
export function signWithIdentityNonce(kp: Keypair, message: Uint8Array): Buffer {
  const a = secretScalar(kp)
  const A = kp.rawPublicKey()
  const R = Point.ZERO.toBytes()
  const k = challenge(R, A, message)
  const S = (k * a) % GROUP_ORDER
  return Buffer.concat([R, numberToBytesLE(S, 32)])
}

/**
 * Test vector: a public key carrying an order-8 component, with a signature
 * over `message` that satisfies the cofactored equation under it.
 */
export function torsionedKeyAndSignature(
  kp: Keypair,
  message: Uint8Array,
): { publicKey: Buffer; signature: Buffer } {
  const a = secretScalar(kp)
  const A = Point.fromBytes(kp.rawPublicKey()).add(TORSION_8).toBytes()
  for (;;) {
    const r = randomScalar()
    const R = Point.BASE.multiply(r).toBytes()
    const k = challenge(R, A, message)
    if (k % 8n === 0n) continue
    const S = (r + k * a) % GROUP_ORDER
    return {
      publicKey: Buffer.from(A),
      signature: Buffer.concat([R, numberToBytesLE(S, 32)]),
    }
  }
}

/**
 * Test vector: the identity point as a public key, with a signature that
 * satisfies the cofactored equation under it.
 */
export function identityKeyAndSignature(): { publicKey: Buffer; signature: Buffer } {
  const S = randomScalar()
  const R = Point.BASE.multiply(S).toBytes()
  return {
    publicKey: Buffer.from(Point.ZERO.toBytes()),
    signature: Buffer.concat([R, numberToBytesLE(S, 32)]),
  }
}

/** `signature` with the group order added to its scalar half: a non-canonical encoding of the same scalar. */
export function withNonCanonicalScalar(signature: Uint8Array): Buffer {
  const S = bytesToNumberLE(signature.subarray(32))
  return Buffer.concat([signature.subarray(0, 32), numberToBytesLE(S + GROUP_ORDER, 32)])
}

/**
 * The identity point encoded with `y = p + 1` instead of `y = 1`: a
 * non-canonical encoding of a valid point.
 */
export function nonCanonicalIdentityEncoding(): Buffer {
  const P = 2n ** 255n - 19n
  return Buffer.from(numberToBytesLE(P + 1n, 32))
}
