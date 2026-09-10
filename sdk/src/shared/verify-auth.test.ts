import {
  Address,
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

/** The ScVal shape of a Soroban account signature: `{ public_key, signature }`. */
const ACCOUNT_SIGNATURE_TYPE = {
  type: { public_key: ['symbol', null], signature: ['symbol', null] },
} as const

type AccountSignature = { public_key: Uint8Array; signature: Uint8Array }

/** The credential arms this verifier accepts, keyed by their XDR union name. */
type Arm = 'address' | 'addressV2'

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

function accountSignature(publicKey: Buffer, signature: Buffer): xdr.ScVal {
  return nativeToScVal({ public_key: publicKey, signature }, ACCOUNT_SIGNATURE_TYPE)
}

/** Reads the signature vector out of an entry's address credentials. */
function signaturesOf(entry: xdr.SorobanAuthorizationEntry): AccountSignature[] {
  return scValToNative(entry.credentials().address().signature()) as AccountSignature[]
}

/** An address-credentials entry for `address`, under the given credential arm. */
function entryFor(
  address: string,
  opts: {
    arm?: Arm
    signature?: xdr.ScVal
    rootInvocation?: xdr.SorobanAuthorizedInvocation
  } = {},
): xdr.SorobanAuthorizationEntry {
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(address).toScAddress(),
    nonce: new xdr.Int64(1),
    signatureExpirationLedger: VALID_UNTIL_LEDGER,
    signature: opts.signature ?? xdr.ScVal.scvVec([]),
  })
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      (opts.arm ?? 'address') === 'address'
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(credentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation: opts.rootInvocation ?? transferInvocation(address),
  })
}

/** An entry the SDK itself signed for `signer`, as an honest client produces. */
function signedEntryFor(
  signer: Keypair,
  opts: { authV2?: boolean } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeInvocation({
    signer,
    validUntilLedgerSeq: VALID_UNTIL_LEDGER,
    invocation: transferInvocation(signer.publicKey()),
    publicKey: signer.publicKey(),
    networkPassphrase: NETWORK,
    ...opts,
  })
}

/** An entry naming `authorizer` as the authorizing address but signed by `attacker`. */
function entrySignedByOther(
  authorizer: Keypair,
  attacker: Keypair,
  opts: { authV2?: boolean } = {},
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeInvocation({
    signer: (preimage: xdr.HashIdPreimage) => ({
      signature: attacker.sign(hash(preimage.toXDR())),
      publicKey: attacker.publicKey(),
    }),
    validUntilLedgerSeq: VALID_UNTIL_LEDGER,
    invocation: transferInvocation(authorizer.publicKey()),
    publicKey: authorizer.publicKey(),
    networkPassphrase: NETWORK,
    ...opts,
  })
}

/**
 * An entry in the `arm` credential arm, signed over the preimage the `preimage`
 * arm derives. Crossing the two is what an attacker replaying a legacy V1
 * signature into the new V2 arm (or the reverse) would present.
 */
function entrySignedOver(signer: Keypair, arm: Arm, preimage: Arm) {
  // Both entries must share one root invocation: the preimage covers it, so a
  // freshly generated one would fail verification for the wrong reason.
  const rootInvocation = transferInvocation(signer.publicKey())
  const payload = hash(
    buildAuthorizationEntryPreimage(
      entryFor(signer.publicKey(), { arm: preimage, rootInvocation }),
      VALID_UNTIL_LEDGER,
      NETWORK,
    ).toXDR(),
  )
  const signature = xdr.ScVal.scvVec([
    accountSignature(signer.rawPublicKey(), signer.sign(payload)),
  ])
  return entryFor(signer.publicKey(), { arm, rootInvocation, signature })
}

describe('verifyAuthEntrySignature', () => {
  it('accepts an entry signed by the authorizing account', async () => {
    const entry = await signedEntryFor(Keypair.random())

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).not.toThrow()
  })

  it('rejects an entry whose signature bytes were tampered with', async () => {
    const entry = await signedEntryFor(Keypair.random())

    const tampered = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
    const [original] = signaturesOf(tampered)
    tampered
      .credentials()
      .address()
      .signature(
        xdr.ScVal.scvVec([
          accountSignature(Buffer.from(original.public_key), Buffer.alloc(64, 0x07)),
        ]),
      )

    expect(() => verifyAuthEntrySignature(tampered, NETWORK)).toThrow(StellarMppError)
  })

  it('rejects an entry verified against a different network passphrase', async () => {
    const entry = await signedEntryFor(Keypair.random())

    expect(() => verifyAuthEntrySignature(entry, OTHER_NETWORK)).toThrow(StellarMppError)
  })

  it('rejects an entry signed by a key other than the authorizing account', async () => {
    const entry = await entrySignedByOther(Keypair.random(), Keypair.random())

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
    const entry = entryFor(CONTRACT_ID)

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('stellar account')
  })

  it('rejects an entry carrying no signatures', () => {
    const entry = entryFor(Keypair.random().publicKey())

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow('no signatures')
  })

  it('rejects an entry whose signature vector carries more than one signature', async () => {
    const signer = Keypair.random()
    const entry = await signedEntryFor(signer)
    const [valid] = signaturesOf(entry)

    // A Soroban account authorizer needs exactly one signature; a vector padded
    // with extra copies must be rejected rather than verified element by element.
    const padded = entryFor(signer.publicKey(), {
      signature: xdr.ScVal.scvVec(
        Array.from({ length: 3 }, () =>
          accountSignature(Buffer.from(valid.public_key), Buffer.from(valid.signature)),
        ),
      ),
    })

    expect(() => verifyAuthEntrySignature(padded, NETWORK)).toThrow('single account signature')
  })

  // Documents the exact account-signature shape this verifier relies on, so a
  // future stellar-sdk change to authorizeEntry that breaks it is caught here.
  it('reads the account signature shape produced by the SDK', async () => {
    const signer = Keypair.random()
    const [sig] = signaturesOf(await signedEntryFor(signer))

    expect(StrKey.encodeEd25519PublicKey(Buffer.from(sig.public_key))).toBe(signer.publicKey())
    expect(sig.signature.length).toBe(64)
  })

  // ── CAP-71 V2 (address-bound) credentials ──────────────────────────────

  it('accepts a V2 entry signed by the authorizing account', async () => {
    const entry = await signedEntryFor(Keypair.random(), { authV2: true })

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
    const entry = entrySignedOver(Keypair.random(), 'addressV2', 'address')

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'does not match the authorization payload',
    )
  })

  it('rejects a V1 entry carrying a signature over the V2 address-bound preimage', () => {
    const entry = entrySignedOver(Keypair.random(), 'address', 'addressV2')

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'does not match the authorization payload',
    )
  })

  it('rejects a V2 entry signed by a key other than the authorizing account', async () => {
    const entry = await entrySignedByOther(Keypair.random(), Keypair.random(), { authV2: true })

    expect(() => verifyAuthEntrySignature(entry, NETWORK)).toThrow(
      'key other than the authorizing account',
    )
  })
})
