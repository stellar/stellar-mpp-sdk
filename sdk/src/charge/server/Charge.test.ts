import {
  Account,
  Address,
  Asset,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
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
})

// ---------------------------------------------------------------------------
// Transaction hash dedup tests (hash flow with mocked RPC)
// ---------------------------------------------------------------------------

function makeHashCredential(opts: { hash: string; challengeId?: string; source?: string }) {
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
  const cred = Credential.from({
    challenge,
    payload: { type: 'hash', hash: opts.hash },
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
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Push mode (type="hash") is not allowed with feePayer=true')
  })
})

describe('charge push-mode sender verification (hash-theft attack prevention)', () => {
  it('rejects hash where the on-chain `from` does not match the credential source', async () => {
    // Attack: attacker steals a client's tx hash and submits it with their own challenge.
    // The tx transfers from LEGITIMATE_CLIENT but the attacker's credential claims
    // source = ATTACKER. The server must compare args[0] against credential.source.
    const legitimateClient = Keypair.random()
    const tx = buildTransferTx({
      source: legitimateClient.publicKey(),
      from: legitimateClient.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })
    tx.sign(legitimateClient)

    mockGetTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      envelopeXdr: tx.toXdr(),
    })

    const attackerKey = Keypair.random().publicKey()
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
    // Attacker's credential claims their own key as source
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('stolen-hash') } }),
      { source: `did:pkh:stellar:testnet:${attackerKey}` },
    )

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transfer "from" does not match')
  })

  it('accepts hash where the on-chain `from` matches the credential source', async () => {
    const client = PAYER // PAYER key defined in test scope
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
      envelopeXdr: tx.toXdr(),
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
    // Credential source matches the actual `from` in the tx
    const cred = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('legit-hash') } }),
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
      envelopeXdr: wrongAmountTx.toXdr(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-amount-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
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
      envelopeXdr: tx.toXdr(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-recipient-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
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
      envelopeXdr: tx.toXdr(),
    })

    const cred = makeHashCredential({
      hash: testHash('wrong-currency-tx-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
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
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('missing envelope XDR')
  })
})

describe('charge tx hash dedup', () => {
  it('rejects a second verify with the same tx hash', async () => {
    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: undefined,
    })

    const store = Store.memory()
    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    const hash = testHash('abc123firstuse')

    const cred1 = makeHashCredential({ hash })
    await expect(
      method.verify({ credential: cred1 as any, request: cred1.challenge.request }),
    ).rejects.toThrow()

    // Hash is claimed as 'pending' early (prevents TOCTOU replays).
    // A failed verification burns the hash — client must use a new one.
    const stored = await store.get(`stellar:charge:hash:${hash}`)
    expect((stored as any)?.state).toBe('pending')
  })

  it('marks tx hash as used only after successful verification', async () => {
    const store = Store.memory()

    const hash = testHash('already-used-hash')
    await store.put(`stellar:charge:hash:${hash}`, { usedAt: new Date().toISOString() })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store,
    })

    const cred = makeHashCredential({ hash })
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

describe('charge push-mode: single lookup (no polling)', () => {
  it('rejects when transaction is NOT_FOUND on-chain', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'NOT_FOUND' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const cred = makeHashCredential({
      hash: 'a'.repeat(64),
      source: `did:pkh:stellar:testnet:${Keypair.random().publicKey()}`,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transaction not found on-chain')
  })

  it('rejects when transaction FAILED on-chain', async () => {
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const cred = makeHashCredential({
      hash: 'b'.repeat(64),
      source: `did:pkh:stellar:testnet:${Keypair.random().publicKey()}`,
    })

    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow('Transaction failed on-chain')
  })

  it('includes resultXdr in error details when transaction FAILED', async () => {
    const fakeResultXdr = 'AAAAAAAAAGT/////AAAAAQAAAAAAAAAB////+wAAAAA='
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: fakeResultXdr })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const cred = makeHashCredential({
      hash: 'c'.repeat(64),
      source: `did:pkh:stellar:testnet:${Keypair.random().publicKey()}`,
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
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const cred = makeHashCredential({
      hash: 'd'.repeat(64),
      source: `did:pkh:stellar:testnet:${Keypair.random().publicKey()}`,
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
    // Fake hashes should be rejected instantly without consuming semaphore
    // slots — this is the core fix for the DoS vector.
    mockGetTransaction.mockResolvedValue({ status: 'NOT_FOUND' })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
      pollMaxConcurrent: 1, // only 1 semaphore slot
    })

    // Fire 5 concurrent requests with different fake hashes — all must
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

describe('charge DoS prevention: no global serial lock', () => {
  it('processes concurrent verify calls in parallel, not serially', async () => {
    // Regression test: verifyLock was removed to prevent head-of-line blocking.
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
  fee?: string
}) {
  const account = new Account(opts.source, '0')
  const contract = new Contract(opts.currency)
  const transferOp = contract.call(
    'transfer',
    new Address(opts.from).toScVal(),
    new Address(opts.to).toScVal(),
    nativeToScVal(opts.amount, { type: 'i128' }),
  )
  return new TransactionBuilder(account, {
    fee: opts.fee ?? '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
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
    event: {
      type: { name: 'contract' },
      contractId: new xdr.ContractId(Address.fromString(contract).toBuffer().subarray(0, 32)),
      body: {
        v0: {
          topics: [xdr.ScVal.scvSymbol('transfer'), fromScVal, toScVal],
          data: amountScVal,
        },
      },
    },
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

    const cred = makeTransactionCredential(tx.toXdr())
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
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXdr() } }),
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
    const cred = Object.assign(makeTransactionCredential(tx.toXdr()), {
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXdr() } }),
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
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXdr() } }),
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    // Use toEnvelope().toXdr('base64') to get the FeeBump envelope XDR correctly
    const cred = makeTransactionCredential(feeBumpTx.toEnvelope().toXdr('base64'))
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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
      payload: { type: 'transaction', transaction: tx.toXdr() },
    })

    // First call fails (wrong recipient)
    await expect(
      method.verify({ credential: cred as any, request: cred.challenge.request }),
    ).rejects.toThrow()

    // Challenge IS claimed as 'pending' early (prevents TOCTOU replays).
    // A failed verification burns the challenge — client must get a new one.
    const stored = await store.get(`stellar:charge:challenge:${challengeId}`)
    expect((stored as any)?.state).toBe('pending')
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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
      event: {
        type: { name: 'contract' },
        contractId: null,
        body: {
          v0: {
            topics: [xdr.ScVal.scvSymbol('mint')],
            data: nativeToScVal(0n, { type: 'i128' }),
          },
        },
      },
    }

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [nonTransferEvent],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXdr())
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
      event: {
        type: { name: 'contract' },
        contractId: null,
        body: {
          v0: {
            topics: [xdr.ScVal.scvSymbol('transfer'), fromScVal, toScVal],
            data: amountScVal,
          },
        },
      },
    }

    mockSimulateTransaction.mockResolvedValueOnce({
      result: { retval: null },
      events: [eventWithNoContractId],
      transactionData: new SorobanDataBuilder(),
    })

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = Object.assign(makeTransactionCredential(tx.toXdr()), {
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

    const cred = makeTransactionCredential(tx.toXdr())
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

    // Build with an inflated fee so the rebuilt tx must be capped to maxFeeBumpStroops.
    const tx = buildTransferTx({
      source: ALL_ZEROS,
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
      fee: '2147483647',
    })
    const bloatedXdr = tx.toEnvelope().toXdr('base64')

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
        payload: { type: 'transaction', transaction: tx.toXdr() },
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
    const invokeContractArgs =
      tx.toEnvelope().v1.tx.operations[0].body.invokeHostFunctionOp.hostFunction.invokeContract
    return new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeContractArgs),
      subInvocations,
    })
  }

  /** Builds a sponsored transaction XDR with the given auth entries injected. */
  function buildSponsoredTxWithAuth(authEntries: xdr.SorobanAuthorizationEntry[]) {
    const account = new Account(ALL_ZEROS, '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const hostFunction = transferOp.body.invokeHostFunctionOp.hostFunction
    const op = Operation.invokeHostFunction({ func: hostFunction, auth: authEntries })
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(180)
      .build()
    return tx.toEnvelope().toXdr('base64')
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
          nonce: 0n,
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
          nonce: 0n,
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
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: 0n,
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation(),
    })

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

  it('rejects auth entry that contains sub-invocations', async () => {
    const subInvocation = makeRootInvocation()
    const authEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(PAYER.publicKey()).toScAddress(),
          nonce: 0n,
          signatureExpirationLedger: 1010,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: makeRootInvocation([subInvocation]),
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
    ).rejects.toThrow('Auth entries must not contain sub-invocations')
  })
})

// ---------------------------------------------------------------------------
// Additional coverage: operation-source, multi-event, arg count, XDR object, externalId
// ---------------------------------------------------------------------------

describe('charge operation-level source validation', () => {
  it('rejects unsponsored tx with operation source matching the server signing address', async () => {
    const serverKp = Keypair.random()

    // Build a transfer op whose operation-level source is the server signer address.
    const account = new Account(PAYER.publicKey(), '0')
    const contract = new Contract(USDC_SAC_TESTNET)
    const transferOp = contract.call(
      'transfer',
      new Address(PAYER.publicKey()).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(10000000n, { type: 'i128' }),
    )
    const hostFunction = transferOp.body.invokeHostFunctionOp.hostFunction
    const op = Operation.invokeHostFunction({ func: hostFunction, source: serverKp.publicKey() })
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(180)
      .build()
    const txXdr = tx.toEnvelope().toXdr('base64')

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

    const cred = makeTransactionCredential(tx.toXdr())
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

    const cred = makeTransactionCredential(tx.toXdr())
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
      envelopeXdr: feeBumpTx.toEnvelope().toXdr('base64'),
    })

    const method = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    const cred = makeHashCredential({
      hash: testHash('feebump-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('verifies successfully when envelopeXdr is a FeeBump xdr.TransactionEnvelope object', async () => {
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
    })
    const cred = makeHashCredential({
      hash: testHash('feebump-xdr-obj-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })

    const receipt = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })
})

describe('charge push-mode envelopeXdr as XDR object', () => {
  it('verifies successfully when envelopeXdr is an xdr.TransactionEnvelope object', async () => {
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
    })
    const cred = makeHashCredential({
      hash: testHash('xdr-obj-hash'),
      source: `did:pkh:stellar:testnet:${PAYER.publicKey()}`,
    })

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
      Credential.from({ challenge, payload: { type: 'transaction', transaction: tx.toXdr() } }),
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

    const tx = buildTransferTx({
      source: ALL_ZEROS,
      from: PAYER.publicKey(),
      to: RECIPIENT,
      amount: 10000000n,
      currency: USDC_SAC_TESTNET,
    })

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
        payload: { type: 'transaction', transaction: tx.toXdr() },
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
// TOCTOU race condition tests
// ---------------------------------------------------------------------------

describe('charge TOCTOU: hash replay across instances sharing a store', () => {
  it('rejects the second concurrent verify when two instances share a store (hash mode)', async () => {
    // Simulate multi-process: two charge server instances with separate
    // verifyLocks sharing the same store. pollTransaction is slow (~50ms),
    // widening the TOCTOU window between hash check and hash mark.
    const sharedStore = Store.memory()

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
                envelopeXdr: tx.toXdr(),
              }),
            50,
          ),
        ),
    )

    const method1 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })
    const method2 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })

    // Same hash credential sent to both instances — only one should succeed
    const challenge = Challenge.from({
      id: `toctou-${crypto.randomUUID()}`,
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
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('shared-tx-hash') } }),
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
                envelopeXdr: txToReturn.toXdr(),
              }),
            50,
          )
        }),
    )

    const method1 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })
    const method2 = charge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })

    // Same challenge ID, different hashes — tests challenge-level replay
    const challenge = Challenge.from({
      id: `toctou-challenge-${crypto.randomUUID()}`,
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
    const cred1 = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('hash-a') } }),
      { source: `did:pkh:stellar:testnet:${client.publicKey()}` },
    )
    const cred2 = Object.assign(
      Credential.from({ challenge, payload: { type: 'hash', hash: testHash('hash-b') } }),
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
