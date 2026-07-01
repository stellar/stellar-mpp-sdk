import {
  Address,
  Contract,
  Keypair,
  Networks,
  StrKey,
  authorizeInvocation,
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
  return authorizeInvocation(
    signer,
    VALID_UNTIL_LEDGER,
    transferInvocation(signer.publicKey()),
    signer.publicKey(),
    NETWORK,
  )
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
    const entry = await authorizeInvocation(
      (preimage: xdr.HashIdPreimage) => ({
        signature: attacker.sign(hash(preimage.toXDR())),
        publicKey: attacker.publicKey(),
      }),
      VALID_UNTIL_LEDGER,
      transferInvocation(authorizer.publicKey()),
      authorizer.publicKey(),
      NETWORK,
    )

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
})
