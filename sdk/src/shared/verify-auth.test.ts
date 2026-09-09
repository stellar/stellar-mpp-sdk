import {
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  authorizeInvocation,
  buildAuthorizationEntryPreimage,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { verifyAuthEntrySignature } from './verify-auth.js'
import { StellarMppError } from './errors.js'

const NETWORK = Networks.TESTNET
const OTHER_NETWORK = Networks.PUBLIC
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const VALID_UNTIL_LEDGER = 1000

function transferInvocation(from: string): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT_ID).toScAddress(),
        functionName: 'transfer',
        args: [
          new Address(from).toScVal(),
          new Address(Keypair.random().publicKey()).toScVal(),
          nativeToScVal(1_000_000n, { type: 'i128' }),
        ],
      }),
    ),
    subInvocations: [],
  })
}

async function signedEntryFor(signer: Keypair): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeInvocation({
    signer,
    validUntilLedgerSeq: VALID_UNTIL_LEDGER,
    invocation: transferInvocation(signer.publicKey()),
    publicKey: signer.publicKey(),
    networkPassphrase: NETWORK,
  })
}

/**
 * Builds an unsigned entry for `signer` under the given credential arm, then
 * signs it over `preimage`. Used to cross the arms deliberately: a V2 entry
 * carrying a V1-preimage signature (or vice versa) is exactly what an attacker
 * who replays a legacy signature into the new arm would present.
 */
function entrySignedOver(
  signer: Keypair,
  arm: 'address' | 'addressV2',
  preimage: 'address' | 'addressV2',
): xdr.SorobanAuthorizationEntry {
  const rootInvocation = transferInvocation(signer.publicKey())
  const unsignedCreds = new xdr.SorobanAddressCredentials({
    address: new Address(signer.publicKey()).toScAddress(),
    nonce: new xdr.Int64(1),
    signatureExpirationLedger: VALID_UNTIL_LEDGER,
    signature: xdr.ScVal.scvVec([]),
  })
  const wrap = (creds: xdr.SorobanAddressCredentials, which: 'address' | 'addressV2') =>
    which === 'address'
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(creds)
      : xdr.SorobanCredentials.sorobanCredentialsAddressV2(creds)

  // The SDK derives the preimage from the arm, so build the preimage from an
  // entry wrapped in `preimage`'s arm, then attach the signature to `arm`.
  const preimageEntry = new xdr.SorobanAuthorizationEntry({
    credentials: wrap(unsignedCreds, preimage),
    rootInvocation,
  })
  const payload = hash(
    buildAuthorizationEntryPreimage(preimageEntry, VALID_UNTIL_LEDGER, NETWORK).toXDR(),
  )
  const sig = nativeToScVal(
    { public_key: signer.rawPublicKey(), signature: signer.sign(payload) },
    { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
  )
  const signedCreds = new xdr.SorobanAddressCredentials({
    address: unsignedCreds.address(),
    nonce: unsignedCreds.nonce(),
    signatureExpirationLedger: VALID_UNTIL_LEDGER,
    signature: xdr.ScVal.scvVec([sig]),
  })
  return new xdr.SorobanAuthorizationEntry({
    credentials: wrap(signedCreds, arm),
    rootInvocation,
  })
}

describe('verifyAuthEntrySignature', () => {
  it('accepts an entry signed by the authorizing account', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).not.toThrow()
  })

  it('rejects an entry whose signature bytes were tampered with', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)

    const tampered = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
    const addrAuth = tampered.credentials().address()
    const [original] = scValToNative(addrAuth.signature()) as Array<{
      public_key: Uint8Array
      signature: Uint8Array
    }>
    const forged = nativeToScVal(
      { public_key: Buffer.from(original.public_key), signature: Buffer.alloc(64, 0x07) },
      { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
    )
    addrAuth.signature(xdr.ScVal.scvVec([forged]))

    expect(() => verifyAuthEntrySignature(tampered, NETWORK)).toThrow(StellarMppError)
  })

  it('rejects an entry verified against a different network passphrase', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)

    expect(() => verifyAuthEntrySignature(entry, OTHER_NETWORK)).toThrow(StellarMppError)
  })

  it('rejects an entry signed by a key other than the authorizing account', async () => {
    const authorizer = Keypair.random()
    const attacker = Keypair.random()

    // Address is the authorizer, but the signature is produced by the attacker.
    const entry = await authorizeInvocation({
      signer: (preimage: xdr.HashIdPreimage) => ({
        signature: attacker.sign(hash(preimage.toXDR())),
        publicKey: attacker.publicKey(),
      }),
      validUntilLedgerSeq: VALID_UNTIL_LEDGER,
      invocation: transferInvocation(authorizer.publicKey()),
      publicKey: authorizer.publicKey(),
      networkPassphrase: NETWORK,
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'key other than the authorizing account',
    )
  })

  it('rejects source-account credentials, which cannot be verified off-chain', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: transferInvocation(Keypair.random().publicKey()),
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('address credentials')
  })

  it('rejects a contract authorizer, whose custom auth cannot be verified off-chain', () => {
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(CONTRACT_ID).toScAddress(),
          nonce: new xdr.Int64(1),
          signatureExpirationLedger: VALID_UNTIL_LEDGER,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: transferInvocation(Keypair.random().publicKey()),
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('stellar account')
  })

  it('rejects an entry carrying no signatures', () => {
    const signer = Keypair.random()
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signer.publicKey()).toScAddress(),
          nonce: new xdr.Int64(1),
          signatureExpirationLedger: VALID_UNTIL_LEDGER,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: transferInvocation(signer.publicKey()),
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('no signatures')
  })

  it('rejects an entry whose signature vector carries more than one signature', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)

    const [valid] = scValToNative(entry.credentials().address().signature()) as Array<{
      public_key: Uint8Array
      signature: Uint8Array
    }>
    // A Soroban account authorizer needs exactly one signature; a vector padded
    // with extra copies must be rejected rather than verified element by element.
    const padded = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
    const copies = Array.from({ length: 3 }, () =>
      nativeToScVal(
        { public_key: Buffer.from(valid.public_key), signature: Buffer.from(valid.signature) },
        { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
      ),
    )
    padded.credentials().address().signature(xdr.ScVal.scvVec(copies))

    expect(() => verifyAuthEntrySignature(padded, NETWORK)).toThrow('single account signature')
  })

  // Documents the exact account-signature shape this verifier relies on, so a
  // future stellar-sdk change to authorizeEntry that breaks it is caught here.
  it('reads the account signature shape produced by the SDK', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)
    const [sig] = scValToNative(entry.credentials().address().signature()) as Array<{
      public_key: Uint8Array
      signature: Uint8Array
    }>

    expect(StrKey.encodeEd25519PublicKey(Buffer.from(sig.public_key))).toBe(signer.publicKey())
    expect(sig.signature.length).toBe(64)
  })

  // ── CAP-71 V2 (address-bound) credentials ──────────────────────────────

  it('accepts a V2 entry signed by the authorizing account', async () => {
    const signer = Keypair.random()
    const entry = await authorizeInvocation({
      signer,
      validUntilLedgerSeq: VALID_UNTIL_LEDGER,
      invocation: transferInvocation(signer.publicKey()),
      publicKey: signer.publicKey(),
      networkPassphrase: NETWORK,
      authV2: true,
    })
    expect(entry.credentials().switch().name).toBe('sorobanCredentialsAddressV2')

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).not.toThrow()
  })

  it('verifies the same signature payload the SDK signs for both arms', () => {
    // Pins the verifier to the SDK's preimage derivation per arm, so a change
    // in either side is caught here rather than on-chain.
    const signer = Keypair.random()
    expect(() =>
      verifyAuthEntrySignature(entrySignedOver(signer, 'address', 'address'), NETWORK),
    ).not.toThrow()
    expect(() =>
      verifyAuthEntrySignature(entrySignedOver(signer, 'addressV2', 'addressV2'), NETWORK),
    ).not.toThrow()
  })

  it('rejects a V2 entry carrying a signature over the legacy V1 preimage', () => {
    const signer = Keypair.random()
    const entry = entrySignedOver(signer, 'addressV2', 'address')

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'does not match the authorization payload',
    )
  })

  it('rejects a V1 entry carrying a signature over the V2 address-bound preimage', () => {
    const signer = Keypair.random()
    const entry = entrySignedOver(signer, 'address', 'addressV2')

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'does not match the authorization payload',
    )
  })

  it('rejects a V2 entry signed by a key other than the authorizing account', async () => {
    const authorizer = Keypair.random()
    const attacker = Keypair.random()
    const entry = await authorizeInvocation({
      signer: (preimage: xdr.HashIdPreimage) => ({
        signature: attacker.sign(hash(preimage.toXDR())),
        publicKey: attacker.publicKey(),
      }),
      validUntilLedgerSeq: VALID_UNTIL_LEDGER,
      invocation: transferInvocation(authorizer.publicKey()),
      publicKey: authorizer.publicKey(),
      networkPassphrase: NETWORK,
      authV2: true,
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'key other than the authorizing account',
    )
  })

  it('rejects delegated credentials, which wrap address credentials but cannot be verified here', () => {
    const signer = Keypair.random()
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: new xdr.SorobanAddressCredentials({
            address: new Address(signer.publicKey()).toScAddress(),
            nonce: new xdr.Int64(1),
            signatureExpirationLedger: VALID_UNTIL_LEDGER,
            signature: xdr.ScVal.scvVec([]),
          }),
          delegates: [],
        }),
      ),
      rootInvocation: transferInvocation(signer.publicKey()),
    })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('address credentials')
  })
})
