import { Point } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'

/** Order of the ed25519 prime-order subgroup (RFC 8032 §5.1, `L`). */
export const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n

export function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Verifies an ed25519 signature with the same rules as the Soroban host's
 * `ed25519_verify` and stellar-core's transaction signature check, so that a
 * signature this function accepts is one the network accepts too.
 *
 * RFC 8032 allows a cofactored and a cofactorless verification equation, and
 * verifiers pick different ones. The Soroban host uses the cofactorless one
 * with these checks, which this function applies as well:
 *
 * - the scalar `S` must be canonical (`S < L`);
 * - the nonce point `R` and the public key `A` must decode canonically, and
 *   neither may be a small-order point;
 * - the group equation `[S]B = R + [k]A` must hold without clearing the
 *   cofactor, as a point equality.
 *
 * Use it wherever the verdict is a prediction of what the chain will accept.
 * Byte inputs of any length or content yield `false` rather than an exception.
 */
export function verifyStrict(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false

  const rBytes = Uint8Array.from(signature.subarray(0, 32))
  const aBytes = Uint8Array.from(publicKey)
  const s = bytesToNumberLE(signature.subarray(32))
  if (s >= GROUP_ORDER) return false

  let R: Point
  let A: Point
  try {
    R = Point.fromBytes(rBytes)
    A = Point.fromBytes(aBytes)
  } catch {
    return false
  }
  if (R.isSmallOrder() || A.isSmallOrder()) return false

  const k = bytesToNumberLE(sha512(concat(rBytes, aBytes, message))) % GROUP_ORDER
  const sB = Point.BASE.multiply(s, false)
  const kA = A.multiply(k, false)
  return R.add(kA).equals(sB)
}
