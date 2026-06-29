import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  authorizeInvocation,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_ZEROS, USDC_SAC_TESTNET } from '../../constants.js'

const mockGetTransaction = vi.fn()
const mockGetAccount = vi.fn()
const mockSimulateTransaction = vi.fn()
const mockSendTransaction = vi.fn()
const mockGetLatestLedger = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getTransaction = mockGetTransaction
        this.getAccount = mockGetAccount
        this.simulateTransaction = mockSimulateTransaction
        this.sendTransaction = mockSendTransaction
        this.getLatestLedger = mockGetLatestLedger
      }),
    },
  }
})

const { charge } = await import('./Charge.js')

/** Pad a label into a valid 64-hex-char transaction hash for push-mode tests. */
function testHash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)
}

const RECIPIENT = Keypair.random().publicKey()

describe('stellar server charge', () => {
  it('creates a server method with correct name and intent', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('charge')
  })

  it('has a verify function', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    expect(typeof method.verify).toBe('function')
  })

  it('throws when store is omitted', () => {
    expect(() =>
      charge({
        recipient: RECIPIENT,
        currency: USDC_SAC_TESTNET,
      } as any),
    ).toThrow('A store is required for charge mode')
  })

  it('accepts custom network', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      network: 'stellar:pubnet',
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts custom rpcUrl', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      rpcUrl: 'https://custom.rpc.example.com',
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with envelopeSigner as Keypair', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random() },
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with envelopeSigner as secret key string', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random().secret() },
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with feeBumpSigner as Keypair', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random() },
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with feeBumpSigner as secret key string', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random().secret() },
    })
    expect(method.name).toBe('stellar')
  })

  it('warns that a configured fee-bump signer must be funded with XLM', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random() },
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fee-bump signer'))
  })

  it('does not warn about fee-bump funding when no fee-bump signer is configured', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random() },
      logger,
    })

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('fee-bump signer'))
  })

  it('accepts custom decimals', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      decimals: 6,
    })
    expect(method.name).toBe('stellar')
  })
})

// ---------------------------------------------------------------------------
// request() transform — CAIP-2 network format
// ---------------------------------------------------------------------------

describe('charge request transform', () => {
  it('emits CAIP-2 network in methodDetails (testnet)', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      network: 'stellar:testnet',
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.network).toBe('stellar:testnet')
  })

  it('emits CAIP-2 network in methodDetails (pubnet)', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      network: 'stellar:pubnet',
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.network).toBe('stellar:pubnet')
  })

  it('includes feePayer when feePayer is configured', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      feePayer: { envelopeSigner: Keypair.random() },
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.feePayer).toBe(true)
  })

  it('omits feePayer when no feePayer configured', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.feePayer).toBeUndefined()
  })

  it('converts amount to base units using decimals', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      decimals: 7,
    })
    const transformed = (method as any).request({
      request: { amount: '0.01', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.amount).toBe('100000')
  })

  it('advertises credentialTypes excluding legacy hash by default (allowUnsignedPush: false)', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.credentialTypes).toEqual(['transaction', 'signedHash'])
  })

  it('advertises credentialTypes including legacy hash when allowUnsignedPush is explicitly true', () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const transformed = (method as any).request({
      request: { amount: '1', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })
    expect(transformed.methodDetails.credentialTypes).toEqual(['transaction', 'signedHash', 'hash'])
  })
})

// ---------------------------------------------------------------------------
// Transaction hash dedup tests (hash flow with mocked RPC)
// ---------------------------------------------------------------------------

function makeHashCredential(opts: {
  hash: string
  challengeId?: string
  source?: string
  signingKey?: Keypair
}) {
  const challenge = Challenge.from({
    id: opts.challengeId ?? `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'charge',
    request: {
      amount: '10000000',
      currency: USDC_SAC_TESTNET,
      recipient: RECIPIENT,
      methodDetails: {
        network: 'stellar:testnet',
      },
    },
  })
  const canonicalHash = opts.hash.toLowerCase()
  const bindingMessage = Buffer.from(`${challenge.id}:${canonicalHash}`)
  const sourceSignature = opts.signingKey
    ? Buffer.from(opts.signingKey.sign(bindingMessage)).toString('hex')
    : Buffer.alloc(64).toString('hex') // placeholder if no key provided
  const cred = Credential.from({
    challenge,
    payload: {
      type: 'hash',
      hash: opts.hash,
      sourceSignature,
    },
  })
  // source is explicitly settable; omitting it tests the "no source" rejection path
  if (opts.source !== undefined) {
    return Object.assign(cred, { source: opts.source })
  }
  return cred
}

describe('charge hash+feePayer rejection', () => {
  it('rejects push mode (type=hash) when feePayer is true', async () => {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: {
          network: 'stellar:testnet',
          feePayer: true,
        },
      },
    })
    const cred = Credential.from({
      challenge,
      payload: { type: 'hash', hash: testHash('some-tx-hash') },
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: Keypair.random() },
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Push mode (type="hash") is not allowed with feePayer=true')
  })
})

describe('charge legacy hash (unsigned push) handling', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset()
  })

  it('rejects legacy hash by default and does not consume hash', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const hash = testHash('legacy-unsigned-hash-default-reject')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'hash', hash },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    await expect(
      method.verify({
        credential: cred as any,
        request: cred.challenge.request,
      }),
    ).rejects.toThrow('Unsigned push mode')

    // Verify the hash was not consumed
    const stored = await store.get(`stellar:charge:hash:${hash}`)
    expect(stored).toBeNull()
  })

  it('accepts legacy hash when explicitly opted in with allowUnsignedPush: true and logs deprecation warning', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const hash = testHash('legacy-unsigned-hash-opted-in')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'hash', hash },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const warnSpy = vi.fn()
    const mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
      logger: mockLogger,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe(hash)

    // Verify that a deprecation warning was logged
    expect(warnSpy).toHaveBeenCalled()
    const warnCall = warnSpy.mock.calls[0]
    expect(warnCall[0]).toContain('[stellar:charge]')
    // The warning should mention unsigned/deprecated
    expect(warnCall[1]).toBeDefined()
    // The logged object should contain the challenge ID and hash
    const loggedObj = warnCall[1] as Record<string, unknown>
    expect(loggedObj.challengeId).toBe(challenge.id)
    expect(loggedObj.hash).toBe(hash)
  })

  it('still rejects legacy hash when allowUnsignedPush is explicitly false', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const hash = testHash('rejected-unsigned-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'hash', hash },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: false,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Unsigned push mode')
  })

  it('does not burn tx hash when rejecting unsigned push by default', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    const hash = testHash('unsigned-not-burned')
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'hash', hash },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    // Reject the unsigned push
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Unsigned push mode')

    // The hash should not be in the store (not burned/claimed)
    const stored = await store.get(`stellar:charge:hash:${hash}`)
    expect(stored).toBeNull()
  })

  it('signedHash credential type still accepts valid signatures when allowUnsignedPush is false', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const hash = testHash('signed-hash-still-works')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: false,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge push-mode payment freshness', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset()
  })

  function freshnessChallenge() {
    return Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
  }

  function signedHashCredential(challenge: ReturnType<typeof freshnessChallenge>, hash: string) {
    return Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )
  }

  it('rejects a signedHash whose on-chain payment is older than the accepted window', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: oneWeekAgo,
    })

    const challenge = freshnessChallenge()
    const hash = testHash('signed-hash-stale-payment')
    const cred = signedHashCredential(challenge, hash)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/too old/i)

    // A rejected stale payment must not consume the dedup slot.
    expect(await store.get(`stellar:charge:hash:${hash.toLowerCase()}`)).toBeNull()
  })

  it('accepts a signedHash whose on-chain payment is recent', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const thirtySecondsAgo = Math.floor(Date.now() / 1000) - 30
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: thirtySecondsAgo,
    })

    const challenge = freshnessChallenge()
    const hash = testHash('signed-hash-recent-payment')
    const cred = signedHashCredential(challenge, hash)

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('rejects a signedHash whose on-chain payment age is reported as a string and is too old', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Soroban RPC returns createdAt as a JSON string of unix seconds.
    const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: String(oneWeekAgo),
    })

    const challenge = freshnessChallenge()
    const hash = testHash('signed-hash-stale-string-age')
    const cred = signedHashCredential(challenge, hash)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('On-chain payment is too old to settle this challenge.')

    expect(await store.get(`stellar:charge:hash:${hash.toLowerCase()}`)).toBeNull()
  })

  it('accepts a signedHash whose on-chain payment age is reported as a string and is recent', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const thirtySecondsAgo = Math.floor(Date.now() / 1000) - 30
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: String(thirtySecondsAgo),
    })

    const challenge = freshnessChallenge()
    const hash = testHash('signed-hash-recent-string-age')
    const cred = signedHashCredential(challenge, hash)

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('refuses to settle when the on-chain payment age is present but unreadable', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: 'not-a-unix-timestamp' as unknown as number,
    })

    const challenge = freshnessChallenge()
    const hash = testHash('signed-hash-unreadable-age')
    const cred = signedHashCredential(challenge, hash)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('On-chain payment age is unavailable; refusing to settle this challenge.')

    expect(await store.get(`stellar:charge:hash:${hash.toLowerCase()}`)).toBeNull()
  })

  // expires = now + 200 with the default 300s lifetime puts challenge issuance at
  // now - 100, so these two tests straddle that anchor.
  function challengeIssuedRecently() {
    const expiresAt = (Math.floor(Date.now() / 1000) + 200) * 1000
    return Object.assign(freshnessChallenge(), { expires: new Date(expiresAt).toISOString() })
  }

  it('rejects a signedHash whose on-chain payment predates the challenge issuance', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // 700s old: within the 900s wall-clock window, but ~600s before issuance.
    const createdAtSeconds = Math.floor(Date.now() / 1000) - 700
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: createdAtSeconds,
    })

    const challenge = challengeIssuedRecently()
    const hash = testHash('signed-hash-pre-challenge-payment')
    const cred = signedHashCredential(challenge, hash)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('On-chain payment predates challenge issuance; cannot settle this challenge.')

    expect(await store.get(`stellar:charge:hash:${hash.toLowerCase()}`)).toBeNull()
  })

  it('accepts a signedHash whose on-chain payment was confirmed after challenge issuance', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // 60s old: after the ~100s-ago issuance anchor, so a legitimate settlement.
    const createdAtSeconds = Math.floor(Date.now() / 1000) - 60
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: createdAtSeconds,
    })

    const challenge = challengeIssuedRecently()
    const hash = testHash('signed-hash-post-challenge-payment')
    const cred = signedHashCredential(challenge, hash)

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('refuses to settle when the challenge expiry is present but unreadable', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Recent payment: passes the wall-clock window, so the issuance anchor is the
    // only remaining gate. An unreadable expiry must not silently skip it.
    const createdAtSeconds = Math.floor(Date.now() / 1000) - 30
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
      createdAt: createdAtSeconds,
    })

    const challenge = Object.assign(freshnessChallenge(), { expires: 'not-a-valid-timestamp' })
    const hash = testHash('signed-hash-unreadable-expiry')
    const cred = signedHashCredential(challenge, hash)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Challenge expiry is unreadable; refusing to settle this challenge.')

    expect(await store.get(`stellar:charge:hash:${hash.toLowerCase()}`)).toBeNull()
  })
})

describe('charge push-mode sender verification', () => {
  it('rejects hash where the on-chain `from` does not match the credential source', async () => {
    // The tx transfers from one payer account while the credential declares another.
    const payerKey = Keypair.random()
    const tx = buildTransferTx({
      source: payerKey.publicKey(),
      from: payerKey.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(payerKey)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const credentialKey = Keypair.random().publicKey()
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'hash', hash: testHash('mismatched-source-hash') },
      }),
      { source: `did:pkh:stellar:testnet:${credentialKey}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer "from" does not match')
  })

  it('accepts hash where the on-chain `from` matches the credential source and sourceSignature is valid', async () => {
    const client = PAYER // PAYER key defined in test scope

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    // Credential source matches the actual `from` in the tx
    const hash = testHash('legit-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('rejects credential with no source (source is mandatory)', async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: 'unused',
    })

    const cred = makeHashCredential({ hash: testHash('no-source-hash') }) // source field absent

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Credential source is required')
  })

  it('rejects credential with malformed source DID', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS', envelopeXdr: 'unused' })
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('bad-did-hash') } }),
      { source: 'not-a-valid-did' },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('invalid format')
  })

  it('rejects source DID with non-stellar namespace', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS', envelopeXdr: 'unused' })
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('eip155-hash') } }),
      { source: `did:pkh:eip155:1:0xabc123` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('invalid format')
  })

  it('rejects source DID with invalid Stellar public key', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS', envelopeXdr: 'unused' })
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('bad-key-hash') } }),
      { source: 'did:pkh:stellar:testnet:NOT_A_VALID_KEY' },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('invalid Stellar public key')
  })
})

describe('charge push-mode verification', () => {
  it('rejects hash whose on-chain tx has wrong amount', async () => {
    // Before the fix, verifySacTransfer swallowed all errors — any successful on-chain tx
    // would be accepted as payment. Now it must throw on wrong transfer parameters.
    const wrongAmountTx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 5000000n, // wrong — challenge expects 10000000
      currency: USDC_SAC_TESTNET,
    })
    wrongAmountTx.sign(PAYER)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: wrongAmountTx.toXDR(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-amount-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer amount does not match')
  })

  it('rejects hash whose on-chain tx transfers to wrong recipient', async () => {
    const wrongRecipient = Keypair.random().publicKey()
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: wrongRecipient,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-recipient-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer "to" does not match')
  })

  it('rejects hash whose on-chain tx uses wrong currency', async () => {
    const wrongCurrency = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: wrongCurrency, // wrong SAC contract
    })
    tx.sign(PAYER)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-currency-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Contract address does not match')
  })

  it('rejects hash when on-chain tx has no envelopeXdr', async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: undefined,
    })

    const cred = makeHashCredential({
      hash: testHash('no-envelope-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('missing envelope XDR')
  })
})

describe('charge tx hash dedup', () => {
  it('releases a pending tx-hash claim when verification fails', async () => {
    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: undefined,
    })

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
      allowUnsignedPush: true,
    })

    const hash = testHash('abc123firstuse')

    const cred1 = makeHashCredential({ hash })
    await expect(
      method.verify({ credential: cred1 as any, request: cred1.challenge.request }),
    ).rejects.toThrow()

    // The hash is claimed early, but the claim must
    // be released if verification fails so a legitimate payer can retry.
    const stored = await store.get(`stellar:charge:hash:${hash}`)
    expect(stored).toBeNull()
  })

  it('rejects a push hash whose canonical (inner) tx hash is already used', async () => {
    const store = Store.memory()

    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Pre-seed the canonical inner-tx-hash dedup entry as already settled. Dedup
    // is keyed on the inner transaction hash (derived from the on-chain envelope),
    // not on whatever hash the client presents.
    const canonicalHash = tx.hash().toString('hex')
    await store.put(`stellar:charge:hash:${canonicalHash}`, {
      state: 'used',
      usedAt: new Date().toISOString(),
    })

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
      allowUnsignedPush: true,
    })

    const cred = makeHashCredential({
      hash: canonicalHash,
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transaction hash already used')
  })
})

describe('charge hash format validation', () => {
  it('rejects a hash that is not 64 hex characters', async () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({ hash: 'not-hex-at-all' })
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Invalid transaction hash format')
  })

  it('rejects a hash that is too short', async () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({ hash: 'abcd1234' })
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Invalid transaction hash format')
  })

  it('rejects a hash that is 64 chars but not hex', async () => {
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({ hash: 'zzzz' + '0'.repeat(60) })
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Invalid transaction hash format')
  })

  it('accepts a valid 64-hex hash', async () => {
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: undefined,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const payer = Keypair.random()
    const cred = makeHashCredential({
      hash: 'a'.repeat(64),
      source: `did:pkh:stellar:testnet:${payer.publicKey()}`,
    })
    // Will fail later (missing envelope), but should NOT fail on hash format
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('missing envelope XDR')
  })
})

describe('charge push-mode: source signature binding', () => {
  it('rejects push-mode credential with invalid sourceSignature', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const hash = testHash('invalid-sig-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.alloc(64).toString('hex'), // invalid/wrong signature
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Source signature does not authorize this payment')
  })

  it('does not burn a tx hash when sourceSignature verification fails', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    const hash = testHash('invalid-sig-does-not-burn-hash')
    mockGetTransaction
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        envelopeXdr: tx.toXDR(),
      })
      .mockResolvedValueOnce({
        status: 'SUCCESS',
        envelopeXdr: tx.toXDR(),
      })

    const firstChallenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const secondChallenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const invalidCred = Object.assign(
      Credential.from({
        challenge: firstChallenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.alloc(64).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const validCred = Object.assign(
      Credential.from({
        challenge: secondChallenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${secondChallenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    await expect(
      method.verify({ credential: invalidCred as any, request: invalidCred.challenge.request }),
    ).rejects.toThrow('Source signature does not authorize this payment')

    const receipt = await method.verify({
      credential: validCred as any,
      request: validCred.challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe(hash.toLowerCase())
  })

  it('rejects push-mode credential when sourceSignature is signed by a different key', async () => {
    const payerKey = PAYER
    const alternateKey = Keypair.random()
    const tx = buildTransferTx({
      source: payerKey.publicKey(),
      from: payerKey.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(payerKey)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const hash = testHash('alternate-signature-hash')
    // The credential source names one account, but the signature comes from another.
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            alternateKey.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${payerKey.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Source signature does not authorize this payment')
  })

  it('accepts push-mode credential with valid sourceSignature by the payer', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const hash = testHash('valid-sig-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('rejects case-variant hash with invalid sourceSignature (lowercase canonicalization)', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXDR(),
    })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    // Uppercase hash but signature signed with lowercase hash
    const hash = 'ABCD' + '0'.repeat(60)
    const lowercaseHash = hash.toLowerCase()
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${lowercaseHash}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    // Should succeed because server canonicalizes the hash to lowercase
    expect(receipt.status).toBe('success')
  })
})

describe('charge push-mode: single lookup (no polling)', () => {
  it('rejects when transaction is NOT_FOUND on-chain', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({ status: 'NOT_FOUND' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({
      hash: 'a'.repeat(64),
      source: `did:pkh:stellar:testnet:${client.publicKey()}`,
      signingKey: client,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transaction not found on-chain')
  })

  it('rejects when transaction FAILED on-chain', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({
      hash: 'b'.repeat(64),
      source: `did:pkh:stellar:testnet:${client.publicKey()}`,
      signingKey: client,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transaction failed on-chain')
  })

  it('includes resultXdr in error details when transaction FAILED', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    const fakeResultXdr = 'AAAAAAAAAGT/////AAAAAQAAAAAAAAAB////+wAAAAA='
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: fakeResultXdr })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({
      hash: 'c'.repeat(64),
      source: `did:pkh:stellar:testnet:${client.publicKey()}`,
      signingKey: client,
    })

    try {
      await method.verify({ credential: cred as any, request: cred.challenge.request })
      expect.unreachable('should have thrown')
    } catch (err: any) {
      expect(err.message).toMatch('Transaction failed on-chain')
      expect(err.details.resultXdr).toBe(fakeResultXdr)
      expect(err.details.hash).toBe('c'.repeat(64))
    }
  })

  it('omits resultXdr from error details when not present in FAILED response', async () => {
    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const cred = makeHashCredential({
      hash: 'd'.repeat(64),
      source: `did:pkh:stellar:testnet:${client.publicKey()}`,
      signingKey: client,
    })

    try {
      await method.verify({ credential: cred as any, request: cred.challenge.request })
      expect.unreachable('should have thrown')
    } catch (err: any) {
      expect(err.message).toMatch('Transaction failed on-chain')
      expect(err.details.resultXdr).toBeUndefined()
      expect(err.details.hash).toBe('d'.repeat(64))
    }
  })

  it('does not hold a semaphore slot for push-mode lookups', async () => {
    // Unknown hashes should be rejected instantly without consuming semaphore
    // slots needed by transaction polls.
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      pollMaxConcurrent: 1, // only 1 semaphore slot
    })

    // Fire 5 concurrent requests with different unknown hashes — all must
    // reject promptly instead of queueing behind a semaphore.
    const start = Date.now()
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => {
        const cred = makeHashCredential({
          hash: `${i}`.repeat(64).slice(0, 64),
          source: `did:pkh:stellar:testnet:${Keypair.random().publicKey()}`,
        })
        return method.verify({ credential: cred as any, request: cred.challenge.request })
      }),
    )
    const elapsed = Date.now() - start

    // All should be rejected (NOT_FOUND)
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    // Should complete quickly — no 20s poll timeout per request
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('charge concurrency: no global serial lock', () => {
  it('processes concurrent verify calls in parallel, not serially', async () => {
    // Regression test: verifyLock was removed to avoid head-of-line blocking.
    // Two concurrent verifications with different hashes must run in parallel,
    // not serially. We verify this by timing: if serial, total time >= 2×delay.
    const delayMs = 50
    mockGetTransaction.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ status: 'SUCCESS', envelopeXdr: undefined }), delayMs),
        ),
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const cred1 = makeHashCredential({ hash: testHash('parallel-a') })
    const cred2 = makeHashCredential({ hash: testHash('parallel-b') })

    const start = Date.now()
    await Promise.allSettled([
      method.verify({ credential: cred1 as any, request: cred1.challenge.request }),
      method.verify({ credential: cred2 as any, request: cred2.challenge.request }),
    ])
    const elapsed = Date.now() - start

    // If serial, elapsed would be >= 2×50 = 100ms. Parallel should be ~50ms.
    expect(elapsed).toBeLessThan(delayMs * 1.8)
  })
})

// ---------------------------------------------------------------------------
// Transaction credential verification tests
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
const PAYER = Keypair.random()

function buildTransferTx(opts: {
  source: string
  from: string
  to: string
  amount: bigint
  currency: string
  memo?: { type: 'hash'; value: Buffer }
}) {
  const account = new Account(opts.source, '0')
  const contract = new Contract(opts.currency)
  const transferOp = contract.call(
    'transfer',
    new Address(opts.from).toScVal(),
    new Address(opts.to).toScVal(),
    nativeToScVal(opts.amount, { type: 'i128' }),
  )
  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
  if (opts.memo) {
    builder.addMemo(Memo.hash(opts.memo.value))
  }
  return builder.addOperation(transferOp).setTimeout(180).build()
}

/**
 * Builds a sponsored transfer transaction (source = ALL_ZEROS) carrying a valid
 * payer-signed authorization entry bound to the transfer, mirroring what an
 * honest sponsored client emits. Returns the envelope so callers can adjust it
 * (e.g. inflate the fee) before serializing to XDR.
 */
async function buildSponsoredEnvelopeWithValidAuth(opts?: {
  amount?: bigint
  expirationLedger?: number
  fee?: number
}) {
  const amount = opts?.amount ?? 10000000n
  const expirationLedger = opts?.expirationLedger ?? 1010
  const tx = buildTransferTx({
    source: ALL_ZEROS,
    from: PAYER.publicKey(),
    to: RECIPIENT,
    amount,
    currency: USDC_SAC_TESTNET,
  })
  const invokeContractArgs = tx
    .toEnvelope()
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .hostFunction()
    .invokeContract()
  const unsignedAuthEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(PAYER.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString('0'),
        signatureExpirationLedger: expirationLedger,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeContractArgs),
      subInvocations: [],
    }),
  })
  const authEntry = await authorizeEntry(
    unsignedAuthEntry,
    PAYER,
    expirationLedger,
    NETWORK_PASSPHRASE,
  )
  const envelope = tx.toEnvelope()
  envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth([authEntry])
  // The auth signature covers the invocation, not the tx fee, so an optional fee
  // override applied here keeps the entry valid while letting callers exercise
  // different inclusion fees.
  if (opts?.fee !== undefined) {
    envelope.v1().tx().fee(opts.fee)
  }
  return envelope
}

function makeTransactionCredential(
  txXdr: string,
  challengeAmount: string = '10000000',
  source: string = `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
) {
  const challenge = Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'charge',
    request: {
      amount: challengeAmount,
      currency: USDC_SAC_TESTNET,
      recipient: RECIPIENT,
      methodDetails: {
        network: 'stellar:testnet',
      },
    },
  })
  return Object.assign(
    Credential.from({ challenge, payload: { type: 'transaction', transaction: txXdr } }),
    { source },
  )
}

function makeMockTransferEvent(from: string, to: string, amount: bigint, contract: string) {
  const fromScVal = new Address(from).toScVal()
  const toScVal = new Address(to).toScVal()
  const amountScVal = nativeToScVal(amount, { type: 'i128' })

  return {
    event: () => ({
      type: () => ({ name: 'contract' }),
      contractId: () => Address.fromString(contract).toBuffer().subarray(0, 32),
      body: () => ({
        v0: () => ({
          topics: () => [{ sym: () => ({ toString: () => 'transfer' }) }, fromScVal, toScVal],
          data: () => amountScVal,
        }),
      }),
    }),
  }
}

function defaultMockEvent() {
  return makeMockTransferEvent(PAYER.publicKey(), RECIPIENT, 10000000n, USDC_SAC_TESTNET)
}

describe('charge transaction verification', () => {
  it('rejects a transaction with exactly one payment operation', async () => {
    const tx = new TransactionBuilder(new Account(PAYER.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: RECIPIENT,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('does not contain a Soroban invocation')
  })

  it('rejects a sponsored transaction with exactly one payment operation', async () => {
    const tx = new TransactionBuilder(new Account(ALL_ZEROS, '0'), {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: RECIPIENT,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(180)
      .build()

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: {
          network: 'stellar:testnet',
          feePayer: true,
        },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXDR() } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: Keypair.random() },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('does not contain a Soroban invocation')
  })

  it('rejects transaction where from address does not match credential source', async () => {
    const actualPayer = Keypair.random()
    const tx = buildTransferTx({
      source: actualPayer.publicKey(),
      from: actualPayer.publicKey(), // tx was built by actualPayer
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(actualPayer)

    // Credential claims PAYER as source, but tx `from` is actualPayer — mismatch
    const cred = Object.assign(makeTransactionCredential(tx.toXDR()), {
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer "from" does not match')
  })

  it('rejects transaction with wrong recipient', async () => {
    const wrongRecipient = Keypair.random().publicKey()
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: wrongRecipient,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer "to" does not match')
  })

  it('rejects transaction with wrong amount', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 5000000n, // wrong amount — challenge expects 10000000
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer amount does not match')
  })

  it('rejects transaction with wrong currency', async () => {
    const wrongCurrency = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: wrongCurrency,
    })
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Contract address does not match')
  })

  it('rejects sponsored source without feePayer configured', async () => {
    const tx = buildTransferTx({
      source: ALL_ZEROS,
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })

    const cred = makeTransactionCredential(tx.toXDR())
    // No feePayer configured
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('sponsored source account but the server has no feePayer configuration')
  })

  it('rejects unsupported credential type', async () => {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Credential.from({
      challenge,
      payload: { type: 'unknown' as any },
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Unsupported credential type')
  })

  it('rejects replay of same challenge ID', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Set up simulation and send to succeed
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'test-hash-replay', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    const challengeId = `replay-test-${crypto.randomUUID()}`
    const challenge = Challenge.from({
      id: challengeId,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXDR() } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    // First call succeeds
    await method.verify({ credential: cred as any, request: cred.challenge.request })

    // Second call with same challenge ID should be rejected
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Challenge already used')
  })

  it('rejects unsponsored tx with timeBounds.maxTime exceeding challenge expires', async () => {
    const farFuture = Math.floor(Date.now() / 1000) + 86400 // 24h from now
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(transferOp)
      .setTimebounds(0, farFuture) // maxTime far in the future
      .build()
    tx.sign(PAYER)

    // Challenge expires sooner than the tx maxTime
    const expiresAt = new Date((farFuture - 3600) * 1000).toISOString() // 1h before farFuture
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      expires: expiresAt,
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXDR() } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('timeBounds.maxTime exceeds challenge expires')
  })

  it('verifies and broadcasts valid unsponsored transaction', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'verified-tx-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe('verified-tx-hash')
    expect(receipt.method).toBe('stellar')
  })

  it('verifies and broadcasts FeeBump-wrapped transfer in unsponsored pull mode', async () => {
    const innerTx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    innerTx.sign(PAYER)

    const feeSource = Keypair.random()
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      innerTx,
      NETWORK_PASSPHRASE,
    )
    feeBumpTx.sign(feeSource)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'feebump-pull-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    // Use toEnvelope().toXDR('base64') to get the FeeBump envelope XDR correctly
    const cred = makeTransactionCredential(feeBumpTx.toEnvelope().toXDR('base64'))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe('feebump-pull-hash')
    // The FeeBump tx (not the inner tx) must be what gets broadcast.
    // FeeBumpTransaction has an innerTransaction property; plain Transaction does not.
    expect(mockSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ innerTransaction: expect.anything() }),
    )
  })

  it('throws SettlementError when broadcast fails', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockRejectedValueOnce(new Error('RPC down'))

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Settlement failed')
  })

  it('throws SettlementError when transaction not confirmed', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'unconfirmed-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: 'tx_failed' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow()
  })

  it('throws SettlementError when sendTransaction returns ERROR status', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'error-hash', status: 'ERROR' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('sendTransaction returned ERROR')
  })

  it('throws SettlementError when sendTransaction returns DUPLICATE status', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'dup-hash', status: 'DUPLICATE' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('sendTransaction returned DUPLICATE')
  })

  it('throws SettlementError when sendTransaction returns TRY_AGAIN_LATER status', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'retry-hash', status: 'TRY_AGAIN_LATER' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('sendTransaction returned TRY_AGAIN_LATER')
  })

  it('does not burn challenge ID when verification fails', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: Keypair.random().publicKey(), // wrong recipient — will fail verification
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    const challengeId = `burn-test-${crypto.randomUUID()}`
    const challenge = Challenge.from({
      id: challengeId,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Credential.from({
      challenge,
      payload: { type: 'transaction', transaction: tx.toXDR() },
    })

    // First call fails (wrong recipient) — a pre-broadcast verification failure.
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow()

    // The transaction never reached the ledger, so the challenge claim is rolled
    // back rather than burned: the payer can retry the same challenge instead of
    // being permanently locked out.
    const stored = await store.get(`stellar:charge:challenge:${challengeId}`)
    expect(stored).toBeNull()
  })
})

describe('charge pull-mode tx-hash dedup', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  function txCredentialForFreshChallenge(txXdr: string) {
    const challenge = Challenge.from({
      id: `dedup-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    return Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: txXdr } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )
  }

  it('rejects a duplicate transaction XDR submitted under a different challenge id', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)
    const txXdr = tx.toXDR()

    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'dedup-onchain-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    // First submission under challenge A succeeds.
    const credA = txCredentialForFreshChallenge(txXdr)
    const receipt = await method.verify({
      credential: credA as any,
      request: credA.challenge.request,
    })
    expect(receipt.status).toBe('success')

    // The same tx XDR under a fresh challenge B must be rejected as a duplicate,
    // even though that challenge has never been used.
    const credB = txCredentialForFreshChallenge(txXdr)
    await expect(
      method.verify({ credential: credB as any, request: credB.challenge.request }),
    ).rejects.toThrow('Transaction hash already used')

    // The duplicate must never be broadcast.
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
  })

  it('does not lock the tx hash when verification fails before broadcast, allowing retry', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)
    const txXdr = tx.toXDR()

    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })

    // First attempt fails at simulation — no broadcast happens.
    mockSimulateTransaction.mockRejectedValueOnce(new Error('simulation boom'))
    const credA = txCredentialForFreshChallenge(txXdr)
    await expect(
      method.verify({ credential: credA as any, request: credA.challenge.request }),
    ).rejects.toThrow()
    expect(mockSendTransaction).not.toHaveBeenCalled()

    // Verification failed before the hash was claimed, so the same tx can be
    // retried successfully under a fresh challenge.
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'retry-onchain-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const credB = txCredentialForFreshChallenge(txXdr)
    const receipt = await method.verify({
      credential: credB as any,
      request: credB.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge pull-mode settlement rollback', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
    mockGetLatestLedger.mockReset()
    mockGetAccount.mockReset()
  })

  function signedTransferCredential() {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)
    return makeTransactionCredential(tx.toXDR())
  }

  it('releases the challenge claim when verification fails before broadcast, so the same challenge can be retried', async () => {
    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })
    const cred = signedTransferCredential()

    // First attempt fails at simulation, before any broadcast.
    mockSimulateTransaction.mockRejectedValueOnce(new Error('simulation boom'))
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('simulation boom')
    expect(mockSendTransaction).not.toHaveBeenCalled()

    // The SAME challenge can be retried: a pre-broadcast failure released the
    // claim instead of permanently consuming it.
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'rollback-retry-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe('rollback-retry-hash')
  })

  it('releases the challenge and tx-hash claims when the broadcast is rejected before reaching the ledger', async () => {
    const store = Store.memory()
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })
    const cred = signedTransferCredential()

    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })

    // Broadcast is rejected synchronously, so the transaction never enters the
    // mempool and cannot be on-chain.
    mockSendTransaction.mockResolvedValueOnce({ hash: 'rejected-hash', status: 'ERROR' })
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/ERROR/)

    // The identical (deterministic) transaction can be retried under the same
    // challenge once the network accepts it — neither claim was permanently held.
    mockSendTransaction.mockResolvedValueOnce({ hash: 'accepted-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })
    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe('accepted-hash')
  })

  it('keeps the challenge and tx-hash claims locked when broadcast succeeds but settlement is unconfirmed', async () => {
    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
      pollMaxAttempts: 1,
      pollDelayMs: 1,
      pollTimeoutMs: 50,
    })
    const cred = signedTransferCredential()

    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'pending-hash', status: 'PENDING' })
    // Never confirms → polling gives up → settlement outcome is ambiguous.
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/reconciliation/i)

    // The broadcast may have reached the ledger, so the same challenge must stay
    // locked to prevent a double settlement.
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Challenge already used')
  })
})

describe('charge simulation event validation', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  it('rejects when simulation returns empty events array', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('no transfer events')
  })

  it('rejects when simulation events field is undefined', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('no transfer events')
  })

  it('rejects when simulation has only non-transfer events', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const nonTransferEvent = {
      event: () => ({
        type: () => ({ name: 'contract' }),
        contractId: () => null,
        body: () => ({
          v0: () => ({
            topics: () => [{ sym: () => ({ toString: () => 'mint' }) }],
            data: () => nativeToScVal(0n, { type: 'i128' }),
          }),
        }),
      }),
    }

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [nonTransferEvent],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('no transfer events')
  })

  it('rejects transfer event with missing contract ID', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const fromScVal = new Address(PAYER.publicKey()).toScVal()
    const toScVal = new Address(RECIPIENT).toScVal()
    const amountScVal = nativeToScVal(10000000n, { type: 'i128' })

    const eventWithNoContractId = {
      event: () => ({
        type: () => ({ name: 'contract' }),
        contractId: () => null,
        body: () => ({
          v0: () => ({
            topics: () => [{ sym: () => ({ toString: () => 'transfer' }) }, fromScVal, toScVal],
            data: () => amountScVal,
          }),
        }),
      }),
    }

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [eventWithNoContractId],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('missing contract ID')
  })

  it('rejects when server signing address is the sender in transfer event', async () => {
    const signerKp = Keypair.random()

    // XDR transfer is from PAYER (passes verifyTokenTransfer), but the simulation
    // event shows the server signing key as sender — must be caught
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [makeMockTransferEvent(signerKp.publicKey(), RECIPIENT, 10000000n, USDC_SAC_TESTNET)],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Server signing address must not be the sender')
  })
})

describe('charge transaction structure validation', () => {
  it('rejects transaction with invokeHostFunction + extra payment operation', async () => {
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(transferOp)
      .addOperation(
        Operation.payment({
          destination: PAYER.publicKey(),
          asset: Asset.native(),
          amount: '5000',
        }),
      )
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('must contain exactly one operation')
  })

  it('rejects transaction with invokeHostFunction + setOptions operation', async () => {
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(transferOp)
      .addOperation(Operation.setOptions({}))
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('must contain exactly one operation')
  })

  it('rejects transaction with uploadWasm host function type', async () => {
    const account = new Account(PAYER.publicKey(), '0')
    const uploadOp = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from('deadbeef', 'hex')),
      auth: [],
    })
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(uploadOp)
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Host function is not a contract invocation')
  })
})

describe('charge SAC invocation validation (fail-closed)', () => {
  it('rejects non-transfer function name with specific error', async () => {
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const approveOp = contract.call(
      'approve',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(approveOp)
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Function name must be "transfer"')
  })
})

describe('charge server signing address protection', () => {
  it('rejects unsponsored tx with source matching server signer', async () => {
    const signerKp = Keypair.random()
    const tx = buildTransferTx({
      source: signerKp.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const cred = Object.assign(makeTransactionCredential(tx.toXDR()), {
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('must not be a server signing address')
  })

  it('allows tx when no feePayer is configured', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'ok-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge sponsored path fee cap', () => {
  it('caps the rebuilt transaction fee to maxFeeBumpStroops', async () => {
    const signerKp = Keypair.random()

    // Inflate the inclusion fee so the server has to cap it back down.
    const envelope = await buildSponsoredEnvelopeWithValidAuth({ fee: 2147483647 })
    const bloatedXdr = envelope.toXDR('base64')

    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '100'))
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'fee-test-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'transaction', transaction: bloatedXdr },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      maxFeeBumpStroops: 10_000_000,
      store: Store.memory(),
    })

    await method.verify({ credential: cred as any, request: cred.challenge.request })

    const sentTx = mockSendTransaction.mock.calls[0][0]
    expect(Number(sentTx.fee)).toBeLessThanOrEqual(10_000_000)
  })
})

describe('charge sponsored path authorization enforcement', () => {
  it('rejects before broadcast when enforcement-mode simulation refuses the supplied authorization', async () => {
    const signerKp = Keypair.random()

    const envelope = await buildSponsoredEnvelopeWithValidAuth()
    const txXdr = envelope.toXDR('base64')

    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '100'))
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 })

    // Model the documented Soroban RPC behavior: recording mode ignores the
    // supplied authorization and returns success, while enforcement mode
    // validates it against ledger state and rejects an entry the network would
    // not honor. The sponsored path must use enforcement so the server does not
    // pay to broadcast a transfer that cannot apply.
    mockSimulateTransaction.mockImplementationOnce(
      (_tx: unknown, _resources: unknown, authMode?: string) => {
        if (authMode === 'enforce') {
          return Promise.resolve({ id: 1, error: 'transaction simulation failed' })
        }
        return Promise.resolve({
          result: { retval: null },
          events: [defaultMockEvent()],
          transactionData: new SorobanDataBuilder(),
        })
      },
    )
    mockSendTransaction.mockResolvedValue({ hash: 'should-not-broadcast', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'transaction', transaction: txXdr },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store,
    })

    // Isolate the broadcast assertion from calls made by earlier tests; mocks
    // are not auto-cleared between tests in this file.
    mockSendTransaction.mockClear()

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Pre-submission simulation failed')

    // The server must not have broadcast (and therefore not paid a fee) for a
    // transfer the enforcement-mode simulation rejected.
    expect(mockSendTransaction).not.toHaveBeenCalled()

    mockGetLatestLedger.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })
})

describe('charge sponsored path expired challenge', () => {
  it('rejects sponsored transaction when challenge has expired', async () => {
    const signerKp = Keypair.random()

    const tx = buildTransferTx({
      source: ALL_ZEROS,
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })

    const pastDate = new Date(Date.now() - 60_000).toISOString() // 1 minute ago

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
      expires: pastDate,
    })
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'transaction', transaction: tx.toXDR() },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Challenge has expired')
  })
})

// ---------------------------------------------------------------------------
// validateAuthEntries security checks (sponsored path)
// ---------------------------------------------------------------------------

describe('charge validateAuthEntries (sponsored path)', () => {
  const signerKp = Keypair.random()

  // Reset the broadcast spy before each test so the "never broadcast" assertions
  // reflect only the test under inspection (no module-level beforeEach resets it).
  beforeEach(() => {
    mockSendTransaction.mockClear()
  })

  /** Reuses the InvokeContractArgs from a real transfer op to keep the root
   *  invocation valid for XDR serialization purposes. */
  function makeRootInvocation(subInvocations: xdr.SorobanAuthorizedInvocation[] = []) {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    const invokeContractArgs = tx
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
    return new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeContractArgs),
      subInvocations,
    })
  }

  /** Builds a sponsored transaction XDR with the given auth entries injected. */
  function buildSponsoredTxWithAuth(authEntries: xdr.SorobanAuthorizationEntry[]) {
    const tx = buildTransferTx({
      source: ALL_ZEROS,
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    const envelope = tx.toEnvelope()
    envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().auth(authEntries)
    return envelope.toXDR('base64')
  }

  /** Creates a sponsored-path credential (feePayer: true in methodDetails). */
  function makeSponsoredCredential(txXdr: string, expires?: string) {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
      ...(expires ? { expires } : {}),
    })
    return Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: txXdr } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )
  }

  it('rejects auth entry using source-account credentials', async () => {
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: makeRootInvocation(),
    })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Only address-type auth entries are permitted')
  })

  it('rejects auth entry whose address matches the server signing key', async () => {
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signerKp.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Server address must not appear in client auth entries')
  })

  it('rejects auth entry with signatureExpirationLedger exceeding the challenge expiry', async () => {
    // challenge expires in ~60s → maxLedger = latestSequence(1000) + ceil(60/5) = 1012
    // auth entry expiration 99999 >> 1012 → rejected
    const futureExpiry = new Date(Date.now() + 60_000).toISOString()
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 99999,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]), futureExpiry)
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Auth entry expiration exceeds maximum allowed ledger')
  })

  it('accepts auth entry with signatureExpirationLedger within the challenge expiry', async () => {
    // challenge expires in ~60s → maxLedger = 1000 + ceil(60/5) = 1012
    // auth entry expiration 1010 ≤ 1012 → accepted
    const futureExpiry = new Date(Date.now() + 60_000).toISOString()
    const unsignedAuthEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })
    const authEntry = await authorizeEntry(unsignedAuthEntry, PAYER, 1010, NETWORK_PASSPHRASE)

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '100'))
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'valid-auth-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]), futureExpiry)
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('accepts an auth entry expiring a few ledgers past the strict bound (RPC ledger-view skew)', async () => {
    // Latest ledger 1000, challenge expires in ~60s → strict maxLedger = 1000 + ceil(60/5) = 1012.
    // The client and server read the latest ledger at different moments from a load-balanced
    // RPC, so the client's view can sit a few ledgers ahead. Expiration 1015 is just past the
    // strict bound but within the ledger-skew tolerance, so it must still be accepted.
    const futureExpiry = new Date(Date.now() + 60_000).toISOString()
    const unsignedAuthEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1015,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })
    const authEntry = await authorizeEntry(unsignedAuthEntry, PAYER, 1015, NETWORK_PASSPHRASE)

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '100'))
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'skew-within-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]), futureExpiry)
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('rejects an auth entry expiring beyond the ledger-skew tolerance', async () => {
    // Strict maxLedger 1012 + ledger-skew tolerance (10) = 1022; expiration 1023 is beyond it
    // and must still be rejected, so the tolerance does not become an open-ended extension.
    const futureExpiry = new Date(Date.now() + 60_000).toISOString()
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1023,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]), futureExpiry)
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Auth entry expiration exceeds maximum allowed ledger')
  })

  it('rejects auth entry that contains sub-invocations', async () => {
    const subInvocation = makeRootInvocation()
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation([subInvocation]),
    })

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 100 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Auth entries must not contain sub-invocations')
  })

  it('rejects auth entry whose signature does not verify', async () => {
    // Well-formed account-signature structure, but the signature bytes are
    // forged. Soroban RPC simulation never checks them, so without an explicit
    // verification the server would broadcast a transfer that fails
    // require_auth on-chain and waste the fee it paid to settle it.
    const forgedSignature = xdr.ScVal.scvVec([
      nativeToScVal(
        { public_key: PAYER.rawPublicKey(), signature: Buffer.alloc(64, 0x07) },
        { type: { public_key: ['symbol', null], signature: ['symbol', null] } },
      ),
    ])
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: forgedSignature,
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 100 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/signature/i)

    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects sponsored settlement when no auth entry authorizes the transfer (empty auth)', async () => {
    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('No authorization entry authorizes the requested transfer.')
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects sponsored settlement when the auth entry authorizer is not the transfer source', async () => {
    const otherPayer = Keypair.random()
    const unsignedAuthEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(otherPayer.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })
    const authEntry = await authorizeEntry(unsignedAuthEntry, otherPayer, 1010, NETWORK_PASSPHRASE)

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 100 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('No authorization entry authorizes the requested transfer.')
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects sponsored settlement when the auth entry authorizes a different transfer', async () => {
    // A validly-signed entry by the payer, but covering a transfer to a
    // different recipient than the operation actually settles.
    const otherRecipient = Keypair.random().publicKey()
    const wrongTx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: otherRecipient,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    const wrongArgs = wrongTx
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
    const unsignedAuthEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('0'),
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(wrongArgs),
        subInvocations: [],
      }),
    })
    const authEntry = await authorizeEntry(unsignedAuthEntry, PAYER, 1010, NETWORK_PASSPHRASE)

    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 100 })

    const cred = makeSponsoredCredential(buildSponsoredTxWithAuth([authEntry]))
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('No authorization entry authorizes the requested transfer.')
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Additional coverage: operation-source, multi-event, arg count, XDR object, externalId
// ---------------------------------------------------------------------------

describe('charge operation-level source validation', () => {
  it('rejects unsponsored tx with operation source matching the server signing address', async () => {
    const serverKp = Keypair.random()

    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    // Inject the server signer address as the operation-level source via XDR
    const envelope = tx.toEnvelope()
    envelope
      .v1()
      .tx()
      .operations()[0]
      .sourceAccount(xdr.MuxedAccount.keyTypeEd25519(serverKp.rawPublicKey()))
    const txXdr = envelope.toXDR('base64')

    tx.sign(PAYER)

    const cred = Object.assign(makeTransactionCredential(txXdr), {
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: serverKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Operation source must not be a server signing address')
  })
})

describe('charge simulation multiple-event rejection', () => {
  it('rejects when simulation produces more than one transfer event', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Two identical transfer events — spec requires exactly one balance change
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent(), defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('2 transfer events; expected exactly 1')
  })
})

describe('charge transfer argument count validation', () => {
  it('rejects transfer invocation with wrong number of arguments', async () => {
    // Build a transfer op with only 2 args (missing amount) — verifyTokenTransfer
    // checks args.length === 3
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const twoArgOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      // deliberately omitted: amount arg
    )
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(twoArgOp)
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const cred = makeTransactionCredential(tx.toXDR())
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer function expects 3 arguments, got 2')
  })
})

describe('charge push-mode FeeBump envelope', () => {
  it('verifies successfully when envelopeXdr is a FeeBump-wrapped transfer', async () => {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const feeSource = Keypair.random()
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      tx,
      NETWORK_PASSPHRASE,
    )
    feeBumpTx.sign(feeSource)

    // Return the FeeBump envelope as the on-chain result (base64 string)
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: feeBumpTx.toEnvelope().toXDR('base64'),
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const hash = testHash('feebump-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('verifies successfully when envelopeXdr is a FeeBump xdr.TransactionEnvelope object', async () => {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    const feeSource = Keypair.random()
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      tx,
      NETWORK_PASSPHRASE,
    )
    feeBumpTx.sign(feeSource)

    // Return the FeeBump envelope as an XDR object directly
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: feeBumpTx.toEnvelope(),
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const hash = testHash('feebump-xdr-obj-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge push-mode envelopeXdr as XDR object', () => {
  it('verifies successfully when envelopeXdr is an xdr.TransactionEnvelope object', async () => {
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    // Return the parsed XDR object directly instead of a base64 string
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toEnvelope(),
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      allowUnsignedPush: true,
    })
    const hash = testHash('xdr-obj-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge receipt externalId', () => {
  it('includes externalId in the receipt when set on the challenge request', async () => {
    const tx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(PAYER)

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'extid-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        externalId: 'order-abc-123',
        methodDetails: { network: 'stellar:testnet' },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXDR() } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect((receipt as any).externalId).toBe('order-abc-123')
  })
})

// ---------------------------------------------------------------------------
// Sponsored path sequence number
// ---------------------------------------------------------------------------

describe('charge sponsored path sequence number', () => {
  beforeEach(() => {
    mockGetAccount.mockReset()
    mockGetLatestLedger.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  it('submits the transaction with the correct sequence (account seq + 1)', async () => {
    const signerKp = Keypair.random()
    const serverSeq = '200'

    const envelope = await buildSponsoredEnvelopeWithValidAuth()

    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), serverSeq))
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'seq-test-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { type: 'transaction', transaction: envelope.toXDR('base64') },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await method.verify({ credential: cred as any, request: cred.challenge.request })

    // The submitted tx must have sequence = serverSeq + 1, NOT serverSeq + 2
    const sentTx = mockSendTransaction.mock.calls[0][0] as Transaction
    const expectedSeq = (BigInt(serverSeq) + 1n).toString()
    expect(sentTx.sequence).toBe(expectedSeq)
  })
})

// ---------------------------------------------------------------------------
// Concurrent coordination tests
// ---------------------------------------------------------------------------

describe('charge hash replay across instances sharing a store', () => {
  it('rejects the second concurrent verify when two instances share a store (hash mode)', async () => {
    // Simulate multi-process: two charge server instances with separate
    // verifyLocks sharing the same store. pollTransaction is slow (~50ms),
    // widening the timing gap between hash check and hash mark.
    const sharedStore = Store.memory()

    const challenge = Challenge.from({
      id: `shared-store-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const client = PAYER
    const tx = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(client)

    // Mock getTransaction to return slowly, simulating pollTransaction delay
    mockGetTransaction.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({
                status: 'SUCCESS',
                envelopeXdr: tx.toXDR(),
              }),
            50,
          ),
        ),
    )

    const method1 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
      allowUnsignedPush: true,
    })
    const method2 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
      allowUnsignedPush: true,
    })

    // Same hash credential sent to both instances — only one should succeed
    const hash = testHash('shared-tx-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const results = await Promise.allSettled([
      method1.verify({ credential: cred as any, request: cred.challenge.request }),
      method2.verify({ credential: cred as any, request: cred.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0] as PromiseRejectedResult).reason.message).toMatch(
      /already used|Replay rejected/,
    )
  })

  it('rejects the second concurrent verify for challenge replay across instances', async () => {
    // Two instances race on the same challenge (hash mode, same challenge ID).
    // Only one should succeed — the challenge must be claimed atomically.
    const sharedStore = Store.memory()

    const challenge = Challenge.from({
      id: `shared-store-challenge-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })

    const client = PAYER
    const tx1 = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx1.sign(client)

    const tx2 = buildTransferTx({
      source: client.publicKey(),
      from: client.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx2.sign(client)

    // Slow poll to widen the window
    let callCount = 0
    mockGetTransaction.mockImplementation(
      () =>
        new Promise((r) => {
          const txToReturn = callCount++ === 0 ? tx1 : tx2
          setTimeout(
            () =>
              r({
                status: 'SUCCESS',
                envelopeXdr: txToReturn.toXDR(),
              }),
            50,
          )
        }),
    )

    const method1 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
      allowUnsignedPush: true,
    })
    const method2 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
      allowUnsignedPush: true,
    })

    // Same challenge ID, different hashes — tests challenge-level replay
    const hashA = testHash('hash-a')
    const hashB = testHash('hash-b')
    const cred1 = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash: hashA,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hashA.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )
    const cred2 = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash: hashB,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hashB.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    const results = await Promise.allSettled([
      method1.verify({ credential: cred1 as any, request: cred1.challenge.request }),
      method2.verify({ credential: cred2 as any, request: cred2.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    expect(successes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Atomic replay protection tests
// ---------------------------------------------------------------------------

describe('atomic challenge replay protection', () => {
  it('atomically prevents challenge replay via store.update (not claimOrThrow)', async () => {
    // Test that the dedup path uses store.update instead of the old claimOrThrow+get+put.
    // We verify this indirectly: if a second redemption of the same challenge is rejected,
    // the update() call must have been the gating mechanism.
    const store = Store.memory()
    const updateSpy = vi.spyOn(store, 'update')

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    // Pre-populate the challenge store key to simulate a first redemption
    const challengeId = 'atomic-test-already-used'
    const challengeStoreKey = `stellar:charge:challenge:${challengeId}`
    await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

    const challenge = Challenge.from({
      id: challengeId,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: { amount: '100', currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
    })

    const client = Keypair.random()
    const hash = testHash('second-attempt-hash')
    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'hash',
          hash,
          sourceSignature: Buffer.from(
            client.sign(Buffer.from(`${challenge.id}:${hash.toLowerCase()}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )

    // Second attempt should be rejected at the store.update() stage
    await expect(
      method.verify({
        credential: cred as any,
        request: cred.challenge.request,
      }),
    ).rejects.toThrow('Challenge already used')

    // Verify that store.update was called for the challenge dedup
    expect(updateSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Fee-bump cross-mode dedup: a fee-bump has two on-chain-resolvable hashes
// (inner tx hash and outer fee-bump hash). The dedup key MUST be canonical per
// on-chain payment so a payment settled via pull cannot be re-settled via push
// (or vice-versa) by presenting the other hash.
// ---------------------------------------------------------------------------
describe('charge fee-bump cross-mode dedup (canonical inner hash)', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
  })

  function buildSignedFeeBump() {
    const innerTx = buildTransferTx({
      source: PAYER.publicKey(),
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    innerTx.sign(PAYER)
    const feeSource = Keypair.random()
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      innerTx,
      NETWORK_PASSPHRASE,
    )
    feeBumpTx.sign(feeSource)
    return { innerTx, feeBumpTx }
  }

  function makeFreshChallenge() {
    return Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet' },
      },
    })
  }

  async function settleViaPull(
    store: ReturnType<typeof Store.memory>,
    feeBumpTx: FeeBumpTransaction,
  ) {
    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValueOnce({
      hash: feeBumpTx.hash().toString('hex'),
      status: 'PENDING',
    })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' }) // poll
    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })
    const pullCred = makeTransactionCredential(feeBumpTx.toEnvelope().toXDR('base64'))
    const receipt = await method.verify({
      credential: pullCred as any,
      request: pullCred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  }

  it('rejects a signedHash push reusing the OUTER hash of a fee-bump already settled via pull', async () => {
    const store = Store.memory()
    const { feeBumpTx } = buildSignedFeeBump()
    const outerHash = feeBumpTx.hash().toString('hex')

    await settleViaPull(store, feeBumpTx)

    // Push leg: fresh challenge, reuse the OUTER fee-bump hash the attacker controls.
    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: feeBumpTx.toEnvelope().toXDR('base64'),
    })
    const challengeB = makeFreshChallenge()
    const pushCred = Object.assign(
      Credential.from({
        challenge: challengeB,
        payload: {
          type: 'signedHash',
          hash: outerHash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challengeB.id}:${outerHash}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })
    await expect(
      method.verify({ credential: pushCred as any, request: pushCred.challenge.request }),
    ).rejects.toThrow('Transaction hash already used')
  })

  it('rejects a legacy hash push reusing the OUTER hash of a fee-bump already settled via pull', async () => {
    const store = Store.memory()
    const { feeBumpTx } = buildSignedFeeBump()
    const outerHash = feeBumpTx.hash().toString('hex')

    await settleViaPull(store, feeBumpTx)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: feeBumpTx.toEnvelope().toXDR('base64'),
    })
    const challengeB = makeFreshChallenge()
    const pushCred = Object.assign(
      Credential.from({
        challenge: challengeB,
        payload: { type: 'hash', hash: outerHash },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
      allowUnsignedPush: true,
    })
    await expect(
      method.verify({ credential: pushCred as any, request: pushCred.challenge.request }),
    ).rejects.toThrow('Transaction hash already used')
  })

  it('still settles a standalone fee-bump push when the payment was not previously settled', async () => {
    const store = Store.memory()
    const { feeBumpTx } = buildSignedFeeBump()
    const outerHash = feeBumpTx.hash().toString('hex')

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: feeBumpTx.toEnvelope().toXDR('base64'),
    })
    const challenge = makeFreshChallenge()
    const pushCred = Object.assign(
      Credential.from({
        challenge,
        payload: {
          type: 'signedHash',
          hash: outerHash,
          sourceSignature: Buffer.from(
            PAYER.sign(Buffer.from(`${challenge.id}:${outerHash}`)),
          ).toString('hex'),
        },
      }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store })
    const receipt = await method.verify({
      credential: pushCred as any,
      request: pushCred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge sponsored fee handling', () => {
  const envelopeKP = Keypair.random()

  beforeEach(() => {
    mockGetAccount.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  async function sponsoredTransferCredential(clientFee: string) {
    // A valid payer-signed auth entry plus the client's chosen inclusion fee.
    const envelope = await buildSponsoredEnvelopeWithValidAuth({ fee: Number(clientFee) })
    const txXdr = envelope.toXDR('base64')
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    return Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: txXdr } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )
  }

  it('sets the sponsored inclusion fee to BASE_FEE regardless of the client tx.fee', async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 })
    mockGetAccount.mockResolvedValue(new Account(envelopeKP.publicKey(), '5'))
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    let submittedFee: string | undefined
    mockSendTransaction.mockImplementation((submitted: { fee: string }) => {
      submittedFee = submitted.fee
      return Promise.resolve({ hash: 'sponsored-fee-hash', status: 'PENDING' })
    })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    // Client inflates tx.fee up to the server's per-settlement cap.
    const cred = await sponsoredTransferCredential('10000000')

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: envelopeKP },
      store: Store.memory(),
    })
    await method.verify({ credential: cred as any, request: cred.challenge.request })

    expect(submittedFee).toBe(BASE_FEE)
  })

  it('rejects when the simulated resource fee pushes the total past the per-settlement cap', async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 })
    mockGetAccount.mockResolvedValue(new Account(envelopeKP.publicKey(), '5'))
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder().setResourceFee(20_000_000n),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'should-not-broadcast', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const cred = await sponsoredTransferCredential(BASE_FEE)

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: envelopeKP },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/fee/i)

    expect(mockSendTransaction).not.toHaveBeenCalled()
  })
})

describe('charge sponsored auth-entry expiration', () => {
  const ENVELOPE = Keypair.random()

  beforeEach(() => {
    mockGetAccount.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
    mockGetLatestLedger.mockReset()
  })

  async function sponsoredCredentialWithAuthEntry(validUntilLedger: number) {
    const account = new Account(ALL_ZEROS, '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: contract.address().toScAddress(),
          functionName: 'transfer',
          args: [
            new Address(PAYER.publicKey()).toScVal(),
            new Address(RECIPIENT).toScVal(),
            nativeToScVal(10000000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    })
    const auth = await authorizeInvocation(
      PAYER,
      validUntilLedger,
      invocation,
      PAYER.publicKey(),
      NETWORK_PASSPHRASE,
    )
    transferOp.body().invokeHostFunctionOp().auth().push(auth)
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(transferOp)
      .setTimeout(180)
      .build()
    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    return Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXDR() } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )
  }

  it('rejects an auth entry whose signature expiration is at or below the latest ledger', async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 })
    mockGetAccount.mockResolvedValue(new Account(ENVELOPE.publicKey(), '5'))
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'should-not-broadcast', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const cred = await sponsoredCredentialWithAuthEntry(50) // expires at ledger 50 <= 100

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: ENVELOPE },
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow(/expired/i)

    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('accepts and settles an auth entry that expires after the latest ledger', async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100 })
    mockGetAccount.mockResolvedValue(new Account(ENVELOPE.publicKey(), '5'))
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    mockSendTransaction.mockResolvedValue({ hash: 'sponsored-auth-ok', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const cred = await sponsoredCredentialWithAuthEntry(200) // expires at ledger 200 > 100

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: ENVELOPE },
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('charge sponsored dedup key (canonical on-chain inner hash)', () => {
  const envelopeKP = Keypair.random()

  beforeEach(() => {
    mockGetAccount.mockReset()
    mockGetLatestLedger.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  it('dedups a sponsored settlement on the broadcast inner hash, not the client tx hash', async () => {
    const store = Store.memory()
    const clientEnvelope = await buildSponsoredEnvelopeWithValidAuth()
    const clientXdr = clientEnvelope.toXDR('base64')
    const clientTxHash = new Transaction(clientXdr, NETWORK_PASSPHRASE).hash().toString('hex')

    mockGetLatestLedger.mockResolvedValue({ sequence: 100 })
    mockGetAccount.mockResolvedValue(new Account(envelopeKP.publicKey(), '5'))
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: null },
      events: [defaultMockEvent()],
      transactionData: new SorobanDataBuilder(),
    })
    let submittedInnerHash: string | undefined
    mockSendTransaction.mockImplementation((submitted: Transaction | FeeBumpTransaction) => {
      const inner = submitted instanceof FeeBumpTransaction ? submitted.innerTransaction : submitted
      submittedInnerHash = inner.hash().toString('hex')
      return Promise.resolve({ hash: submittedInnerHash, status: 'PENDING' })
    })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const challenge = Challenge.from({
      id: `test-${crypto.randomUUID()}`,
      realm: 'localhost',
      method: 'stellar',
      intent: 'charge',
      request: {
        amount: '10000000',
        currency: USDC_SAC_TESTNET,
        recipient: RECIPIENT,
        methodDetails: { network: 'stellar:testnet', feePayer: true },
      },
    })
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'transaction', transaction: clientXdr } }),
      { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      feePayer: { envelopeSigner: envelopeKP },
      store,
    })
    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')

    expect(submittedInnerHash).toBeDefined()
    // The rebuilt (broadcast) tx has the signer as source, so its hash differs
    // from the client's ALL_ZEROS-source tx.
    expect(submittedInnerHash).not.toBe(clientTxHash)
    // Dedup must key on the actual on-chain inner hash — the same key push mode
    // derives from the on-chain envelope — not the client's pre-rebuild tx hash.
    expect(await store.get(`stellar:charge:hash:${submittedInnerHash}`)).not.toBeNull()
    expect(await store.get(`stellar:charge:hash:${clientTxHash}`)).toBeNull()
  })
})
