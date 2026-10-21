import { Point } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'

/** Order of the ed25519 prime-order subgroup (RFC 8032 §5.1, `L`). */
export const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n

export function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

/**
 * Verifies an ed25519 signature with the rules the Soroban host and
 * stellar-core apply, so a signature accepted here is one the network accepts:
 * the scalar must be canonical, the nonce point and public key must decode
 * canonically and not be small-order, and the group equation must hold as an
 * exact point equality, without clearing the cofactor. Malformed input yields
 * `false` rather than an exception.
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

  const k = bytesToNumberLE(sha512(Buffer.concat([rBytes, aBytes, message]))) % GROUP_ORDER
  const sB = Point.BASE.multiply(s, false)
  const kA = A.multiply(k, false)
  return R.add(kA).equals(sB)
}
