import { hashes, verify as verifyCofactored } from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { Keypair } from '@stellar/stellar-sdk'
import { createPublicKey, randomBytes, verify as verifyOpenSsl } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyStrict } from './ed25519.js'

// noble's synchronous verify needs a SHA-512 provider; set it here rather than
// relying on another import having done so.
hashes.sha512 = sha512
import {
  identityKeyAndSignature,
  nonCanonicalIdentityEncoding,
  signWithIdentityNonce,
  signWithTorsionedNonce,
  torsionedKeyAndSignature,
  withNonCanonicalScalar,
} from './ed25519.test-helpers.js'

const MESSAGE = Buffer.from('channel commitment bytes')

/** SPKI DER prefix for a raw ed25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** OpenSSL's verifier, used as an independent cofactorless reference. */
function verifyWithOpenSsl(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
  const key = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  })
  return verifyOpenSsl(null, message, key, signature)
}

/** Confirms a vector satisfies the cofactored equation, so a rejection below is meaningful. */
function satisfiesCofactoredEquation(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) {
  return verifyCofactored(signature, message, publicKey, { zip215: true })
}

describe('verifyStrict', () => {
  it('accepts signatures produced by a Stellar keypair', () => {
    for (let i = 0; i < 20; i++) {
      const kp = Keypair.random()
      const message = randomBytes(1 + (i % 100))
      const signature = kp.sign(message)

      expect(verifyStrict(message, signature, kp.rawPublicKey())).toBe(true)
    }
  })

  it('accepts a signature over an empty message', () => {
    const kp = Keypair.random()
    const message = Buffer.alloc(0)

    expect(verifyStrict(message, kp.sign(message), kp.rawPublicKey())).toBe(true)
  })

  it('rejects a signature over a different message', () => {
    const kp = Keypair.random()

    expect(verifyStrict(Buffer.from('other'), kp.sign(MESSAGE), kp.rawPublicKey())).toBe(false)
  })

  it('rejects a signature by a different key', () => {
    const kp = Keypair.random()

    expect(verifyStrict(MESSAGE, kp.sign(MESSAGE), Keypair.random().rawPublicKey())).toBe(false)
  })

  it('rejects a signature whose bytes were altered', () => {
    const kp = Keypair.random()
    const signature = Buffer.from(kp.sign(MESSAGE))
    signature[5] ^= 0x01

    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects a nonce point with an order-8 component', () => {
    const kp = Keypair.random()
    const signature = signWithTorsionedNonce(kp, MESSAGE)

    expect(satisfiesCofactoredEquation(MESSAGE, signature, kp.rawPublicKey())).toBe(true)
    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects a small-order nonce point', () => {
    const kp = Keypair.random()
    const signature = signWithIdentityNonce(kp, MESSAGE)

    expect(satisfiesCofactoredEquation(MESSAGE, signature, kp.rawPublicKey())).toBe(true)
    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects a public key with an order-8 component', () => {
    const { publicKey, signature } = torsionedKeyAndSignature(Keypair.random(), MESSAGE)

    expect(satisfiesCofactoredEquation(MESSAGE, signature, publicKey)).toBe(true)
    expect(verifyStrict(MESSAGE, signature, publicKey)).toBe(false)
  })

  it('rejects a small-order public key', () => {
    const { publicKey, signature } = identityKeyAndSignature()

    expect(satisfiesCofactoredEquation(MESSAGE, signature, publicKey)).toBe(true)
    expect(verifyStrict(MESSAGE, signature, publicKey)).toBe(false)
  })

  it('rejects a non-canonical scalar encoding of a valid signature', () => {
    const kp = Keypair.random()
    const signature = withNonCanonicalScalar(kp.sign(MESSAGE))

    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects a non-canonical public key encoding', () => {
    const kp = Keypair.random()

    expect(verifyStrict(MESSAGE, kp.sign(MESSAGE), nonCanonicalIdentityEncoding())).toBe(false)
  })

  it('rejects a non-canonical nonce point encoding', () => {
    const kp = Keypair.random()
    const signature = Buffer.from(kp.sign(MESSAGE))
    nonCanonicalIdentityEncoding().copy(signature, 0)

    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects an x = 0 point encoded with the sign bit set', () => {
    const kp = Keypair.random()
    const publicKey = Buffer.alloc(32)
    publicKey[0] = 1
    publicKey[31] = 0x80

    expect(verifyStrict(MESSAGE, kp.sign(MESSAGE), publicKey)).toBe(false)
  })

  it('rejects a nonce point encoding that is not on the curve', () => {
    const kp = Keypair.random()
    const signature = Buffer.from(kp.sign(MESSAGE))
    // y = 2 has no square root for x on ed25519, so this encoding does not decode.
    signature.fill(0, 0, 32)
    signature[0] = 2

    expect(verifyStrict(MESSAGE, signature, kp.rawPublicKey())).toBe(false)
  })

  it('rejects a public key encoding that is not on the curve', () => {
    const kp = Keypair.random()
    const publicKey = Buffer.alloc(32)
    publicKey[0] = 2

    expect(verifyStrict(MESSAGE, kp.sign(MESSAGE), publicKey)).toBe(false)
  })

  it.each([
    ['a 63-byte signature', 63, 32],
    ['a 65-byte signature', 65, 32],
    ['a 31-byte public key', 64, 31],
    ['a 33-byte public key', 64, 33],
  ])('rejects %s without throwing', (_label, signatureLength, publicKeyLength) => {
    expect(
      verifyStrict(MESSAGE, Buffer.alloc(signatureLength), Buffer.alloc(publicKeyLength)),
    ).toBe(false)
  })

  it('agrees with OpenSSL on standard, torsioned-nonce and torsioned-key vectors', () => {
    for (let i = 0; i < 20; i++) {
      const kp = Keypair.random()
      const message = randomBytes(32)
      const publicKey = kp.rawPublicKey()
      const standard = kp.sign(message)
      const torsionedNonce = signWithTorsionedNonce(kp, message)
      const torsionedKey = torsionedKeyAndSignature(kp, message)

      expect(verifyStrict(message, standard, publicKey)).toBe(
        verifyWithOpenSsl(message, standard, publicKey),
      )
      expect(verifyStrict(message, torsionedNonce, publicKey)).toBe(
        verifyWithOpenSsl(message, torsionedNonce, publicKey),
      )
      expect(verifyStrict(message, torsionedKey.signature, torsionedKey.publicKey)).toBe(
        verifyWithOpenSsl(message, torsionedKey.signature, torsionedKey.publicKey),
      )
    }
  })
})
