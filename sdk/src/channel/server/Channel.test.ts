import { Account, Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock stubs — accessible inside the vi.mock factory
const mockGetAccount = vi.fn()
const mockSimulateTransaction = vi.fn()
const mockGetChannelState = vi.fn()
const mockSendTransaction = vi.fn()
const mockGetTransaction = vi.fn()
const mockPrepareTransaction = vi.fn()
const mockFromXDR = vi.fn()
const mockWrapFeeBump = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const OriginalTransactionBuilder = actual.TransactionBuilder
  return {
    ...actual,
    TransactionBuilder: Object.assign(
      function (...args: any[]) {
        return new (OriginalTransactionBuilder as any)(...args)
      },
      {
        ...OriginalTransactionBuilder,
        fromXDR: (...args: unknown[]) => mockFromXDR(...args),
      },
    ),
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getAccount = mockGetAccount
        this.simulateTransaction = mockSimulateTransaction
        this.sendTransaction = mockSendTransaction
        this.getTransaction = mockGetTransaction
        this.prepareTransaction = mockPrepareTransaction
      }),
    },
  }
})

vi.mock('./State.js', () => ({
  getChannelState: (...args: unknown[]) => mockGetChannelState(...args),
}))

vi.mock('../../shared/fee-bump.js', () => ({
  wrapFeeBump: (...args: unknown[]) => mockWrapFeeBump(...args),
}))

// Re-import after mock is set up
const { channel } = await import('./Channel.js')

// Default: getAccount returns a minimal account stub with a valid public key
const MOCK_SOURCE_KEY = Keypair.random()
mockGetAccount.mockResolvedValue({
  accountId: () => MOCK_SOURCE_KEY.publicKey(),
  sequenceNumber: () => '0',
  sequence: () => '0',
  incrementSequenceNumber: () => {},
})

const COMMITMENT_KEY = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

/**
 * Build a fake credential for testing verify().
 */
function makeCredential(opts: {
  action?: 'voucher' | 'close'
  amount: string
  challengeAmount?: string
  cumulativeAmount?: string
  signature?: string
}) {
  const challenge = Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'channel',
    request: {
      amount: opts.challengeAmount ?? opts.amount,
      channel: CHANNEL_ADDRESS,
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: opts.cumulativeAmount ?? '0',
      },
    },
  })
  return Credential.from({
    challenge,
    payload: {
      action: opts.action ?? 'voucher',
      amount: opts.amount,
      signature: opts.signature ?? 'a'.repeat(128),
    },
  })
}

/** Build a credential with a real ed25519 signature over `commitmentBytes`. */
function makeSignedCredential(opts: {
  action?: 'voucher' | 'close'
  commitmentBytes: Buffer
  cumulativeAmount: bigint
  challengeAmount: string
  previousCumulative?: string
}) {
  const sig = COMMITMENT_KEY.sign(opts.commitmentBytes)
  const sigHex = Buffer.from(sig).toString('hex')
  const challenge = Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'channel',
    request: {
      amount: opts.challengeAmount,
      channel: CHANNEL_ADDRESS,
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: opts.previousCumulative ?? '0',
      },
    },
  })
  return Credential.from({
    challenge,
    payload: {
      action: opts.action ?? 'voucher',
      amount: opts.cumulativeAmount.toString(),
      signature: sigHex,
    },
  })
}

/** Create a successful simulation result returning given commitment bytes. */
function successSimResult(commitmentBytes: Buffer) {
  return {
    result: {
      retval: {
        bytes: () => commitmentBytes,
      },
    },
    transactionData: 'mock',
  }
}

describe('stellar server channel', () => {
  it('throws at construction when store is omitted (JS runtime guard)', () => {
    expect(() =>
      channel({
        channel: CHANNEL_ADDRESS,
        commitmentKey: COMMITMENT_KEY.publicKey(),
      } as any),
    ).toThrow('store is required')
  })

  it('creates a server method with correct name and intent', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('channel')
  })

  it('has a verify function', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      store: Store.memory(),
    })
    expect(typeof method.verify).toBe('function')
  })

  it('requires store for replay protection and cumulative tracking', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts custom network', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      network: 'stellar:pubnet',
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts custom rpcUrl', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      rpcUrl: 'https://custom.rpc.example.com',
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts commitmentKey as Keypair', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts custom decimals', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      decimals: 6,
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with envelopeSigner', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      feePayer: { envelopeSigner: Keypair.random() },
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('accepts feePayer with envelopeSigner and feeBumpSigner', () => {
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random() },
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
  })

  it('defaults checkOnChainState to true', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 1000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const commitmentBytes = Buffer.from('default-check-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    // No checkOnChainState — should default to true
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(mockGetChannelState).toHaveBeenCalled()
  })

  it('logs warning when checkOnChainState is explicitly disabled', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('checkOnChainState is disabled'),
    )
  })
})

describe('stellar server channel verification', () => {
  beforeEach(() => {
    // Default mock for verifyCommitmentSignature (called before cumulative checks)
    mockSimulateTransaction.mockResolvedValue({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (require('@stellar/stellar-sdk').SorobanDataBuilder)(),
      events: [],
    })
  })

  it('rejects underpayment (commitment does not cover requested amount)', async () => {
    // Commitment = 500000, but challenge requests 1000000 → should reject
    // Use a proper ed25519 signature for this to pass signature verification
    const commitmentBytes = Buffer.from('test-commitment-500000')
    const signature = COMMITMENT_KEY.sign(commitmentBytes)
    const credential = makeCredential({
      amount: '500000',
      challengeAmount: '1000000',
      signature: Buffer.from(signature).toString('hex'),
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    // Mock the simulate response to return commitment bytes that match our signature
    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(commitmentBytes) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('does not cover the requested amount')
  })

  it('rejects commitment below previous cumulative', async () => {
    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    await store.put(cumulativeKey, { amount: '5000000' })

    // Commitment = 3000000, previous cumulative = 5000000 → reject
    // Use a proper ed25519 signature for this to pass signature verification
    const commitmentBytes = Buffer.from('test-commitment-3000000')
    const signature = COMMITMENT_KEY.sign(commitmentBytes)
    const credential = makeCredential({
      amount: '3000000',
      challengeAmount: '1000000',
      signature: Buffer.from(signature).toString('hex'),
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Mock the simulate response to return commitment bytes that match our signature
    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(commitmentBytes) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('must be greater than previous cumulative')
  })

  it('rejects zero-amount challenge request', async () => {
    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '0',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Invalid amount')
  })

  it('rejects commitment equal to previous cumulative (no progress)', async () => {
    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    await store.put(cumulativeKey, { amount: '5000000' })

    // Commitment = 5000000, previous cumulative = 5000000 → reject (must be strictly greater)
    // Use a proper ed25519 signature for this to pass signature verification
    const commitmentBytes = Buffer.from('test-commitment-5000000')
    const signature = COMMITMENT_KEY.sign(commitmentBytes)
    const credential = makeCredential({
      amount: '5000000',
      challengeAmount: '1000000',
      signature: Buffer.from(signature).toString('hex'),
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Mock the simulate response to return commitment bytes that match our signature
    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(commitmentBytes) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('must be greater than previous cumulative')
  })

  it('rejects invalid hex signature', async () => {
    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
      signature: 'zz-not-hex!!',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Invalid signature')
  })

  it('rejects wrong-length signature', async () => {
    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
      signature: 'abcdef12', // only 8 hex chars, need 128
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Invalid signature')
  })

  it('rejects invalid ed25519 signature (bad sig, valid hex)', async () => {
    const commitmentBytes = Buffer.from('test-commitment-data')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    // Use a valid-length hex string that is NOT a valid signature
    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
      signature: 'ab'.repeat(64), // 128 hex chars, 64 bytes, but wrong sig
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Commitment signature verification failed')
  })

  it('accepts valid commitment and updates cumulative in store', async () => {
    const commitmentBytes = Buffer.from('valid-commitment-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    expect(receipt.status).toBe('success')

    // Verify cumulative was updated in the store
    const stored = (await store.get(cumulativeKey)) as { amount: string }
    expect(stored.amount).toBe('1000000')
  })

  it('does not update cumulative on verification failure', async () => {
    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`

    // Credential that will fail (underpayment)
    const credential = makeCredential({
      amount: '500000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow()

    // Store should not have been updated
    const stored = await store.get(cumulativeKey)
    expect(stored).toBeNull()
  })

  it('rejects replay of same challenge ID', async () => {
    const commitmentBytes = Buffer.from('replay-test-bytes')
    mockSimulateTransaction.mockResolvedValue(successSimResult(commitmentBytes))

    const store = Store.memory()

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // First call should succeed
    await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    // Same credential (same challenge.id) should be rejected
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Replay rejected')
  })

  it('rejects close action when signer is not configured', async () => {
    const commitmentBytes = Buffer.from('close-test-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Close action requires a feePayer')
  })

  it('settles close on-chain and marks channel as closed in store', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-settle-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '50'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'close-settle-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const store = Store.memory()
    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store,
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.reference).toBe('close-settle-hash')

    // Channel marked as closed
    const closed = await store.get(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
    expect(closed).toBeDefined()
    expect((closed as any).txHash).toBe('close-settle-hash')
    expect((closed as any).amount).toBe('5000000')

    // Challenge marked as used
    const challenge = await store.get(`stellar:channel:challenge:${credential.challenge.id}`)
    expect(challenge).toBeDefined()

    // Cumulative advanced after successful close
    const cumulative = await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    expect(cumulative).toBeDefined()
    expect((cumulative as any).amount).toBe('5000000')
  })

  it('rejects close when sendTransaction returns non-PENDING status', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-reject-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '51'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'err-hash', status: 'ERROR' })

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('sendTransaction returned ERROR')
  })

  it('rejects close when sendTransaction returns TRY_AGAIN_LATER', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-tryagain-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '52'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({
      hash: 'try-hash',
      status: 'TRY_AGAIN_LATER',
    })

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('sendTransaction returned TRY_AGAIN_LATER')
  })

  it('rejects close when poll returns non-SUCCESS status', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-poll-fail')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '53'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'poll-fail-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: 'some-error' })

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('poll-fail-hash failed')
  })

  it('wraps close tx in FeeBump when feeBumpSigner is set', async () => {
    const signerKp = Keypair.random()
    const bumpKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-bump-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '54'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockWrapFeeBump.mockReturnValueOnce({ fake: 'fee-bump-tx' })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'bump-close-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp, feeBumpSigner: bumpKp },
      store: Store.memory(),
    })

    const callsBefore = mockWrapFeeBump.mock.calls.length
    const sendsBefore = mockSendTransaction.mock.calls.length

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(mockWrapFeeBump.mock.calls.length).toBe(callsBefore + 1)
    // The fee-bumped tx is what gets sent
    expect(mockSendTransaction.mock.calls[sendsBefore][0]).toEqual({ fake: 'fee-bump-tx' })
  })

  it('does not mark channel as closed when broadcast fails', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-no-mark')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '55'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'no-mark-hash', status: 'ERROR' })

    const store = Store.memory()
    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store,
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow()

    // Channel should NOT be marked as closed
    const closed = await store.get(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
    expect(closed).toBeNull()

    // Challenge IS claimed as 'pending' early in the verification flow.
    const challenge = await store.get(`stellar:channel:challenge:${credential.challenge.id}`)
    expect((challenge as any)?.state).toBe('pending')

    // Cumulative IS advanced eagerly — the commitment signature was validated
    // and can be used for a retry. Writing eagerly allows the cumulative lock
    // to be released before the long on-chain broadcast, so unrelated work is
    // not blocked on the network round trip.
    const cumulative = await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    expect((cumulative as any)?.amount).toBe('5000000')
  })
})

describe('stellar server channel dispute detection', () => {
  it('rejects voucher when channel is closed (effective ledger reached)', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 1000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: 5000,
      currentLedger: 5500, // past effective → closed
    })

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Channel is closed')
  })

  it('calls onDisputeDetected when close_start detected but not yet effective', async () => {
    const disputeState = {
      balance: 1000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: 6000,
      currentLedger: 5500, // before effective → still open, but dispute started
    }
    mockGetChannelState.mockResolvedValueOnce(disputeState)

    const commitmentBytes = Buffer.from('dispute-test-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const onDisputeDetected = vi.fn()

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      onDisputeDetected,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    // Verification should still succeed (channel not yet closed)
    expect(receipt.status).toBe('success')
    // But dispute callback should have been called
    expect(onDisputeDetected).toHaveBeenCalledWith(disputeState)
  })

  it('rejects voucher when on-chain check fails (network error)', async () => {
    mockGetChannelState.mockRejectedValueOnce(new Error('network timeout'))

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store: Store.memory(),
    })

    // Fail closed — on-chain check failure now rejects the voucher
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('On-chain state check failed')
  })

  it('caches on-chain state in store', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 5000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const commitmentBytes = Buffer.from('cache-test-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory()

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store,
    })

    await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    const cached = (await store.get(`stellar:channel:state:${CHANNEL_ADDRESS}`)) as {
      balance: string
      currentLedger: number
    }
    expect(cached).not.toBeNull()
    expect(cached.balance).toBe('5000000')
    expect(cached.currentLedger).toBe(4000)
  })

  it('skips on-chain check when checkOnChainState is false', async () => {
    mockGetChannelState.mockClear()

    const commitmentBytes = Buffer.from('skip-check-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: false,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    expect(receipt.status).toBe('success')
    expect(mockGetChannelState).not.toHaveBeenCalled()
  })

  it('rejects voucher after channel closure', async () => {
    const store = Store.memory()
    await store.put(`stellar:channel:closed:${CHANNEL_ADDRESS}`, {
      closedAt: new Date().toISOString(),
      txHash: 'abc123',
      amount: '5000000',
    })

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Channel has been closed')
  })

  it('wraps non-Error thrown by getChannelState in ChannelVerificationError', async () => {
    mockGetChannelState.mockRejectedValueOnce('raw string failure')

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('On-chain state check failed')
  })

  it('does not call onDisputeDetected when closeEffectiveAtLedger is null', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 5000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const commitmentBytes = Buffer.from('no-dispute-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const onDisputeDetected = vi.fn()

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      onDisputeDetected,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(onDisputeDetected).not.toHaveBeenCalled()
  })

  it('passes through when commitment is within balance and channel is not closing', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 5000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const commitmentBytes = Buffer.from('within-balance-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 5000000n, // exactly at balance
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })

    expect(receipt.status).toBe('success')
  })

  it('rejects commitment that exceeds on-chain balance', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 500000n, // less than commitment
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      store: Store.memory(),
    })

    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('exceeds channel balance')
  })
})

// ── close() standalone function ───────────────────────────────────────────────

describe('close()', () => {
  beforeEach(() => {
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
    mockWrapFeeBump.mockReset()
  })

  // Import close from the same mocked module
  let closeFn: (typeof import('./Channel.js'))['close']

  it('loads the close function', async () => {
    const mod = await import('./Channel.js')
    closeFn = mod.close
    expect(typeof closeFn).toBe('function')
  })

  it('broadcasts close transaction and returns hash on success', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(1)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '100'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'close-tx-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const hash = await closeFn({
      channel: CHANNEL_ADDRESS,
      amount: 5000000n,
      signature,
      feePayer: { envelopeSigner: signer },
      network: 'stellar:testnet',
    })

    expect(hash).toBe('close-tx-hash')
    expect(mockSendTransaction).toHaveBeenCalled()
  })

  it('throws ChannelVerificationError when sendTransaction returns ERROR', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(2)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '101'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'err-hash', status: 'ERROR' })

    await expect(
      closeFn({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature,
        feePayer: { envelopeSigner: signer },
        network: 'stellar:testnet',
      }),
    ).rejects.toThrow('sendTransaction returned ERROR')
  })

  it('throws ChannelVerificationError when sendTransaction returns DUPLICATE', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(3)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '102'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'dup-hash', status: 'DUPLICATE' })

    await expect(
      closeFn({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature,
        feePayer: { envelopeSigner: signer },
        network: 'stellar:testnet',
      }),
    ).rejects.toThrow('sendTransaction returned DUPLICATE')
  })

  it('throws ChannelVerificationError when sendTransaction returns TRY_AGAIN_LATER', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(9)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '110'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({
      hash: 'try-again-hash',
      status: 'TRY_AGAIN_LATER',
    })

    await expect(
      closeFn({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature,
        feePayer: { envelopeSigner: signer },
        network: 'stellar:testnet',
      }),
    ).rejects.toThrow('sendTransaction returned TRY_AGAIN_LATER')
  })

  it('throws when poll returns non-SUCCESS status', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(4)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '103'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'fail-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: 'error-xdr' })

    await expect(
      closeFn({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature,
        feePayer: { envelopeSigner: signer },
        network: 'stellar:testnet',
      }),
    ).rejects.toThrow(/failed/i)
  })

  it('wraps in FeeBumpTransaction when feeBumpSigner is provided', async () => {
    const signer = Keypair.random()
    const feeBumpSigner = Keypair.random()
    const signature = new Uint8Array(64).fill(5)
    const fakeBumpTx = { isBumped: true }

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '104'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockWrapFeeBump.mockReturnValueOnce(fakeBumpTx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'bump-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const hash = await closeFn({
      channel: CHANNEL_ADDRESS,
      amount: 5000000n,
      signature,
      feePayer: { envelopeSigner: signer, feeBumpSigner },
      network: 'stellar:testnet',
    })

    expect(hash).toBe('bump-hash')
    expect(mockWrapFeeBump).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publicKey: feeBumpSigner.publicKey }),
      expect.objectContaining({ networkPassphrase: expect.any(String) }),
    )
    expect(mockSendTransaction).toHaveBeenCalledWith(fakeBumpTx)
  })

  it('accepts secret key strings for envelopeSigner and feeBumpSigner', async () => {
    const signer = Keypair.random()
    const signature = new Uint8Array(64).fill(6)

    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '105'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'str-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const hash = await closeFn({
      channel: CHANNEL_ADDRESS,
      amount: 5000000n,
      signature,
      feePayer: { envelopeSigner: signer.secret() },
      network: 'stellar:testnet',
    })

    expect(hash).toBe('str-hash')
  })
})

// ---------------------------------------------------------------------------
// Concurrent coordination tests
// ---------------------------------------------------------------------------

describe('channel challenge replay across instances sharing a store', () => {
  it('rejects the second concurrent verify when two instances share a store', async () => {
    // Simulate multi-process: two server instances with separate verifyLocks
    // but sharing the same store. A slow RPC (simulateTransaction) widens the
    // timing gap between the challenge check and the challenge mark.
    const sharedStore = Store.memory()
    const commitmentBytes = Buffer.from('shared-store-race-bytes')

    // simulateTransaction returns slowly to widen the race window
    mockSimulateTransaction.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(successSimResult(commitmentBytes)), 50)),
    )
    mockGetChannelState.mockResolvedValue({
      balance: 9999999n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const method1 = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })
    const method2 = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })

    // Same credential sent to both instances — only one should succeed
    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const results = await Promise.allSettled([
      method1.verify({ credential: credential as any, request: credential.challenge.request }),
      method2.verify({ credential: credential as any, request: credential.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect((failures[0] as PromiseRejectedResult).reason.message).toContain(
      'Challenge already used',
    )
  })

  it('rejects the second concurrent verify for cumulative tracking across instances', async () => {
    // Two instances race to update the cumulative amount with the same credential.
    // Only one should succeed; the other should see the updated cumulative.
    const sharedStore = Store.memory()
    const commitmentBytes1 = Buffer.from('shared-store-cumulative-bytes')

    mockSimulateTransaction.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(successSimResult(commitmentBytes1)), 50)),
    )

    const method1 = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })
    const method2 = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })

    const credential = makeSignedCredential({
      commitmentBytes: commitmentBytes1,
      cumulativeAmount: 500000n,
      challengeAmount: '500000',
    })

    const results = await Promise.allSettled([
      method1.verify({ credential: credential as any, request: credential.challenge.request }),
      method2.verify({ credential: credential as any, request: credential.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    expect(successes).toHaveLength(1)
  })
})

// ── close-settlement window coordination tests ─────────────────────────────────

describe('channel vouchers during close settlement window', () => {
  // Before each test, clear all mocks to prevent cross-test contamination
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  it('rejects voucher racing after close cumulative update but before settling marker write', async () => {
    const backingStore = Store.memory()
    const settlingKey = `stellar:channel:settling:${CHANNEL_ADDRESS}`
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`

    let closeCumulativeWritten!: () => void
    const closeCumulativeWrittenPromise = new Promise<void>((resolve) => {
      closeCumulativeWritten = resolve
    })

    let releaseSettlingWrite!: () => void
    const releaseSettlingWritePromise = new Promise<void>((resolve) => {
      releaseSettlingWrite = resolve
    })

    const sharedStore: Store.AtomicStore = {
      get: (key) => backingStore.get(key),
      async put(key, value) {
        if (key === settlingKey) {
          await closeCumulativeWrittenPromise
          await releaseSettlingWritePromise
        }
        return backingStore.put(key, value)
      },
      delete: (key) => backingStore.delete(key),
      async update(key, fn) {
        const result = await backingStore.update(key, fn as never)
        if (key === cumulativeKey) {
          const current = await backingStore.get(key)
          if (
            current &&
            typeof current === 'object' &&
            'amount' in current &&
            (current as { amount?: string }).amount === '100'
          ) {
            closeCumulativeWritten()
          }
        }
        return result
      },
    }

    const closeBytes = Buffer.from('close-before-settling-marker')
    const voucherBytes = Buffer.from('voucher-during-marker-gap')
    mockSimulateTransaction
      .mockResolvedValueOnce(successSimResult(closeBytes))
      .mockResolvedValueOnce(successSimResult(voucherBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(Keypair.random().publicKey(), '200'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'close-marker-gap-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS', hash: 'close-marker-gap-hash' })

    const closer = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: Keypair.random() },
      store: sharedStore,
    })
    const voucherVerifier = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })

    const closeCredential = makeSignedCredential({
      action: 'close',
      commitmentBytes: closeBytes,
      cumulativeAmount: 100n,
      challengeAmount: '100',
    })
    const closePromise = closer.verify({
      credential: closeCredential as any,
      request: closeCredential.challenge.request,
    })

    await closeCumulativeWrittenPromise

    const voucherCredential = makeSignedCredential({
      action: 'voucher',
      commitmentBytes: voucherBytes,
      cumulativeAmount: 110n,
      challengeAmount: '10',
      previousCumulative: '100',
    })

    try {
      await expect(
        voucherVerifier.verify({
          credential: voucherCredential as any,
          request: voucherCredential.challenge.request,
        }),
      ).rejects.toThrow('settling')
    } finally {
      releaseSettlingWrite()
      await closePromise
    }
  })

  it('rejects voucher with settling marker message when close settlement is pending', async () => {
    // Direct test: when a settling marker is set, any new credential (voucher, close, open) is rejected.
    // This gate closes the timing window: credentials arriving during phase-2 settlement of a close
    // will see the marker set under the lock and be rejected atomically.
    const store = Store.memory()
    const settlingKey = `stellar:channel:settling:${CHANNEL_ADDRESS}`

    // Pre-populate store with a settling marker (simulates a close in phase-2 settlement)
    await store.put(settlingKey, {
      settlingAmount: '5000000',
      settledAt: new Date().toISOString(),
    })

    const commitmentBytes = Buffer.from('voucher-during-settling')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      action: 'voucher',
      commitmentBytes,
      cumulativeAmount: 6000000n,
      challengeAmount: '1000000',
      previousCumulative: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Voucher should be rejected because channel is settling
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('settling')
  })

  it('rejects close action when channel is already settling', async () => {
    // If a close fails to settle and leaves the settling marker, a retry close should also be rejected
    const store = Store.memory()
    const settlingKey = `stellar:channel:settling:${CHANNEL_ADDRESS}`

    await store.put(settlingKey, {
      settlingAmount: '5000000',
      settledAt: new Date().toISOString(),
    })

    const commitmentBytes = Buffer.from('retry-close-during-settling')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 6000000n,
      challengeAmount: '1000000',
      previousCumulative: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Close should be rejected because channel is already settling
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('settling')
  })

  it('rejects voucher and close credentials when settling marker is set (concurrency test)', async () => {
    // Test the fail-closed behavior: once a settling marker is set, ALL actions are rejected,
    // preventing new credentials from being accepted until settlement completes or the operator
    // intervenes.

    const store = Store.memory()
    const settlingKey = `stellar:channel:settling:${CHANNEL_ADDRESS}`

    // Simulate: a close began settling and left the marker set
    await store.put(settlingKey, {
      settlingAmount: '5000000',
      settledAt: new Date().toISOString(),
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // 1. Voucher action should be rejected
    const voucherBytes = Buffer.from('voucher-during-settling')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(voucherBytes))

    const voucherCredential = makeCredential({
      action: 'voucher',
      amount: '1000000',
      challengeAmount: '1000000',
    })

    await expect(
      method.verify({
        credential: voucherCredential as any,
        request: voucherCredential.challenge.request,
      }),
    ).rejects.toThrow('settling')

    // 2. Close action should be rejected
    const closeBytes = Buffer.from('close-during-settling')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(closeBytes))

    const closeCredential = makeCredential({
      action: 'close',
      amount: '2000000',
      challengeAmount: '1000000',
    })

    await expect(
      method.verify({
        credential: closeCredential as any,
        request: closeCredential.challenge.request,
      }),
    ).rejects.toThrow('settling')

    // Settling marker should still be present (unchanged)
    const settlingMarker = await store.get(settlingKey)
    expect(settlingMarker).not.toBeNull()
  })

  it('sets settling marker under lock when close credential accepted, and marker persists after settlement fails, blocking subsequent vouchers', async () => {
    // Integration test: verifies the fail-closed settlement failure path.
    // 1. Close credential is accepted and sets the settling marker under the lock
    // 2. On-chain settlement FAILS (poll returns FAILED status)
    // 3. close() verify() rejects with an error
    // 4. The settling marker remains in the store with the committed amount
    // 5. A subsequent voucher is rejected with the "settling" error (channel locked)
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('settlement-fail-test-bytes')
    // First mock: prepare_commitment (for commitment signature verification)
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '200'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'fail-settlement-hash', status: 'PENDING' })
    // Poll returns FAILED, simulating on-chain settlement failure
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: 'settlement-failed' })

    const store = Store.memory()
    const settlingKey = `stellar:channel:settling:${CHANNEL_ADDRESS}`

    // Verify settling marker is NOT present initially
    let settlingMarker = await store.get(settlingKey)
    expect(settlingMarker).toBeNull()

    const credential = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store,
    })

    // Attempt close — settlement will fail
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('fail-settlement-hash failed')

    // After failure, settling marker must be present with the committed amount
    settlingMarker = await store.get(settlingKey)
    expect(settlingMarker).not.toBeNull()
    expect((settlingMarker as any).settlingAmount).toBe('5000000')
    expect((settlingMarker as any).settledAt).toBeDefined()

    // Now attempt a voucher on the same channel — should be rejected with "settling" error
    const voucherBytes = Buffer.from('voucher-after-failed-settlement')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(voucherBytes))

    const voucherCredential = makeSignedCredential({
      action: 'voucher',
      commitmentBytes: voucherBytes,
      cumulativeAmount: 6000000n,
      challengeAmount: '1000000',
      previousCumulative: '5000000',
    })

    await expect(
      method.verify({
        credential: voucherCredential as any,
        request: voucherCredential.challenge.request,
      }),
    ).rejects.toThrow('settling')

    // Verify the settling marker is still present (fail-closed)
    settlingMarker = await store.get(settlingKey)
    expect(settlingMarker).not.toBeNull()
    expect((settlingMarker as any).settlingAmount).toBe('5000000')
  })

  it('enforces fee budget: rejects second close within window when budget exceeded', async () => {
    const signerKp = Keypair.random()
    const bytes1 = Buffer.from('budget-test-bytes')
    const bytes2 = Buffer.from('second-close-bytes')
    // Mock simulate to return matching commitment bytes
    let callCount = 0
    mockSimulateTransaction.mockImplementation(() => {
      callCount++
      const bytes = callCount === 1 ? bytes1 : bytes2
      return Promise.resolve(successSimResult(bytes))
    })
    mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '100'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockWrapFeeBump.mockImplementation((tx) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'budget-test-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const maxFeeBumpStroops = 5_000_000
    const windowMs = 10_000

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      maxFeeBumpStroops,
      feeBudget: {
        maxStroops: maxFeeBumpStroops,
        windowMs,
      },
      store,
    })

    // First close settlement — should succeed, charges maxFeeBumpStroops against budget
    const credential1 = makeSignedCredential({
      action: 'close',
      commitmentBytes: bytes1,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const receipt1 = await method.verify({
      credential: credential1 as any,
      request: credential1.challenge.request,
    })
    expect(receipt1.status).toBe('success')

    // Verify budget record exists and has consumed the charge
    const budgetKey = `stellar:channel:feebudget:${signerKp.publicKey()}`
    const budgetRecord1 = (await store.get(budgetKey)) as any
    expect(budgetRecord1).not.toBeNull()
    expect(budgetRecord1.spentStroops).toBe(maxFeeBumpStroops)
    expect(budgetRecord1.windowStartMs).toBeDefined()

    // Manually clear the closed marker so we can attempt another close
    // This simulates testing budget without channel closure blocking us
    await store.delete(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
    await store.delete(`stellar:channel:settling:${CHANNEL_ADDRESS}`)
    // Also clear cumulative to allow next settlement (must be increasing)
    await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    // Also clear the challenge so we can use a new credential
    await store.delete(`stellar:channel:challenge:${credential1.challenge.id}`)

    // Second close settlement within window — should fail (budget exceeded)
    const credential2 = makeSignedCredential({
      action: 'close',
      commitmentBytes: bytes2,
      cumulativeAmount: 2000000n,
      challengeAmount: '1000000',
    })

    await expect(
      method.verify({
        credential: credential2 as any,
        request: credential2.challenge.request,
      }),
    ).rejects.toThrow(/Fee budget exceeded/i)

    // Verify sendTransaction was NOT called for the second settlement
    const sendCalls = mockSendTransaction.mock.calls.length
    expect(sendCalls).toBe(1) // only from first close

    // Verify budget record is unchanged (second settlement rejected before charge)
    const budgetRecord2 = (await store.get(budgetKey)) as any
    expect(budgetRecord2.spentStroops).toBe(maxFeeBumpStroops)
  })

  it('accumulates fee budget across repeated settlements and rejects once the cap is reached', async () => {
    const signerKp = Keypair.random()
    const maxFeeBumpStroops = 5_000_000
    // Budget allows exactly 2 settlements (2 × the per-settlement charge); the 3rd must be rejected.
    const allowedSettlements = 2
    const windowMs = 60_000

    // Each settlement uses distinct commitment bytes; the cumulative must strictly increase.
    const settlementBytes = [
      Buffer.from('accumulate-close-1'),
      Buffer.from('accumulate-close-2'),
      Buffer.from('accumulate-close-3'),
    ]
    let callCount = 0
    mockSimulateTransaction.mockImplementation(() => {
      const bytes = settlementBytes[callCount] ?? settlementBytes[settlementBytes.length - 1]
      callCount++
      return Promise.resolve(successSimResult(bytes))
    })
    mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '200'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockWrapFeeBump.mockImplementation((tx) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'accumulate-test-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const budgetKey = `stellar:channel:feebudget:${signerKp.publicKey()}`

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      maxFeeBumpStroops,
      feeBudget: {
        maxStroops: maxFeeBumpStroops * allowedSettlements,
        windowMs,
      },
      store,
    })

    // The first `allowedSettlements` closes succeed, each charging one unit against the budget.
    for (let i = 0; i < allowedSettlements; i++) {
      const credential = makeSignedCredential({
        action: 'close',
        commitmentBytes: settlementBytes[i],
        cumulativeAmount: BigInt((i + 1) * 1_000_000),
        challengeAmount: '1000000',
      })
      const receipt = await method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      })
      expect(receipt.status).toBe('success')

      const budgetRecord = (await store.get(budgetKey)) as any
      expect(budgetRecord.spentStroops).toBe(maxFeeBumpStroops * (i + 1))

      // Clear per-channel lifecycle markers so the next close can proceed (the budget
      // record persists across settlements — that is what we are exercising here).
      await store.delete(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
      await store.delete(`stellar:channel:settling:${CHANNEL_ADDRESS}`)
      await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
      await store.delete(`stellar:channel:challenge:${credential.challenge.id}`)
    }

    expect(mockSendTransaction.mock.calls.length).toBe(allowedSettlements)

    // The next settlement exceeds the cap and must be rejected before broadcast.
    const overBudget = makeSignedCredential({
      action: 'close',
      commitmentBytes: settlementBytes[allowedSettlements],
      cumulativeAmount: BigInt((allowedSettlements + 1) * 1_000_000),
      challengeAmount: '1000000',
    })
    await expect(
      method.verify({
        credential: overBudget as any,
        request: overBudget.challenge.request,
      }),
    ).rejects.toThrow(/Fee budget exceeded/i)

    // No extra broadcast, and the budget record is unchanged (rejected before the charge).
    expect(mockSendTransaction.mock.calls.length).toBe(allowedSettlements)
    const finalBudget = (await store.get(budgetKey)) as any
    expect(finalBudget.spentStroops).toBe(maxFeeBumpStroops * allowedSettlements)
  })

  it('allows new settlement after fee budget window elapses', async () => {
    const signerKp = Keypair.random()
    const windowBytes1 = Buffer.from('window-elapsed-bytes')
    const windowBytes2 = Buffer.from('post-window-bytes')
    let callCount = 0
    mockSimulateTransaction.mockImplementation(() => {
      callCount++
      const bytes = callCount === 1 ? windowBytes1 : windowBytes2
      return Promise.resolve(successSimResult(bytes))
    })
    mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '101'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockWrapFeeBump.mockImplementation((tx) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'window-test-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const maxFeeBumpStroops = 5_000_000
    const windowMs = 100 // 100 ms window

    // Use fake timers to control time
    vi.useFakeTimers()

    try {
      const method = channel({
        channel: CHANNEL_ADDRESS,
        checkOnChainState: false,
        commitmentKey: COMMITMENT_KEY,
        feePayer: { envelopeSigner: signerKp },
        maxFeeBumpStroops,
        feeBudget: {
          maxStroops: maxFeeBumpStroops,
          windowMs,
        },
        store,
      })

      const startTime = Date.now()
      vi.setSystemTime(startTime)

      // First close settlement at t=0
      const credential1 = makeSignedCredential({
        action: 'close',
        commitmentBytes: windowBytes1,
        cumulativeAmount: 1000000n,
        challengeAmount: '1000000',
      })

      const receipt1 = await method.verify({
        credential: credential1 as any,
        request: credential1.challenge.request,
      })
      expect(receipt1.status).toBe('success')

      // Clear channel closed state to test window expiry
      await store.delete(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
      await store.delete(`stellar:channel:settling:${CHANNEL_ADDRESS}`)
      // Also clear cumulative to allow next settlement (must be increasing)
      await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
      // Also clear the challenge
      await store.delete(`stellar:channel:challenge:${credential1.challenge.id}`)

      const budgetKey = `stellar:channel:feebudget:${signerKp.publicKey()}`
      const budgetRecord = (await store.get(budgetKey)) as any
      expect(budgetRecord.windowStartMs).toBe(startTime)

      // Advance time past the window
      vi.setSystemTime(startTime + windowMs + 10)

      // Second close settlement after window elapses — should succeed and start new window
      const credential2 = makeSignedCredential({
        action: 'close',
        commitmentBytes: windowBytes2,
        cumulativeAmount: 2000000n,
        challengeAmount: '1000000',
      })

      const receipt2 = await method.verify({
        credential: credential2 as any,
        request: credential2.challenge.request,
      })
      expect(receipt2.status).toBe('success')

      // Verify second settlement was broadcast
      const sendCalls = mockSendTransaction.mock.calls.length
      expect(sendCalls).toBe(2)

      // Verify budget record has a new window
      const budgetRecordNew = (await store.get(budgetKey)) as any
      expect(budgetRecordNew.spentStroops).toBe(maxFeeBumpStroops)
      expect(budgetRecordNew.windowStartMs).toBe(startTime + windowMs + 10)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows many settlements when fee budget is not configured', async () => {
    const signerKp = Keypair.random()
    const noBudgetBytes1 = Buffer.from('no-budget-bytes')
    const noBudgetBytes2 = Buffer.from('second-no-budget-bytes')
    let callCount = 0
    mockSimulateTransaction.mockImplementation(() => {
      callCount++
      const bytes = callCount === 1 ? noBudgetBytes1 : noBudgetBytes2
      return Promise.resolve(successSimResult(bytes))
    })
    mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '103'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockWrapFeeBump.mockImplementation((tx) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'no-budget-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const maxFeeBumpStroops = 5_000_000

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      maxFeeBumpStroops,
      // NO feeBudget configured — backward compatibility
      store,
    })

    // First close
    const credential1 = makeSignedCredential({
      action: 'close',
      commitmentBytes: noBudgetBytes1,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const receipt1 = await method.verify({
      credential: credential1 as any,
      request: credential1.challenge.request,
    })
    expect(receipt1.status).toBe('success')

    // Clear channel state to allow second close (simulating different time / channel)
    await store.delete(`stellar:channel:closed:${CHANNEL_ADDRESS}`)
    await store.delete(`stellar:channel:settling:${CHANNEL_ADDRESS}`)
    // Also clear cumulative to allow next settlement (must be increasing)
    await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    // Also clear the challenge
    await store.delete(`stellar:channel:challenge:${credential1.challenge.id}`)

    // Second close — no budget so should succeed
    const credential2 = makeSignedCredential({
      action: 'close',
      commitmentBytes: noBudgetBytes2,
      cumulativeAmount: 2000000n,
      challengeAmount: '1000000',
    })

    const receipt2 = await method.verify({
      credential: credential2 as any,
      request: credential2.challenge.request,
    })
    expect(receipt2.status).toBe('success')

    // Verify both settlements were broadcast (no fee budget enforcement)
    const sendCalls = mockSendTransaction.mock.calls.length
    expect(sendCalls).toBe(2)
  })

  it('uses fee bump key as funder when feeBumpSigner is set', async () => {
    const signerKp = Keypair.random()
    const bumpKp = Keypair.random()
    const commitmentBytes = Buffer.from('bump-funder-bytes')
    mockSimulateTransaction.mockResolvedValue(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '104'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockWrapFeeBump.mockImplementation((tx) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'bump-funder-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })

    const store = Store.memory()
    const maxFeeBumpStroops = 5_000_000
    const windowMs = 10_000

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp, feeBumpSigner: bumpKp },
      maxFeeBumpStroops,
      feeBudget: {
        maxStroops: maxFeeBumpStroops,
        windowMs,
      },
      store,
    })

    // First close settlement
    const credential1 = makeSignedCredential({
      action: 'close',
      commitmentBytes,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const receipt1 = await method.verify({
      credential: credential1 as any,
      request: credential1.challenge.request,
    })
    expect(receipt1.status).toBe('success')

    // Verify budget is tracked under fee bump key, not envelope signer key
    const budgetKeyBump = `stellar:channel:feebudget:${bumpKp.publicKey()}`
    const budgetKeyEnvelope = `stellar:channel:feebudget:${signerKp.publicKey()}`

    const budgetRecordBump = await store.get(budgetKeyBump)
    const budgetRecordEnvelope = await store.get(budgetKeyEnvelope)

    expect(budgetRecordBump).not.toBeNull()
    expect(budgetRecordEnvelope).toBeNull()
    expect((budgetRecordBump as any).spentStroops).toBe(maxFeeBumpStroops)
  })

  it('does not apply fee budget to standalone close() function', async () => {
    const signerKp = Keypair.random()
    const amount = 1000000n
    const signature = Buffer.from('standalone-close-sig')

    mockSendTransaction.mockResolvedValueOnce({ hash: 'standalone-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '105'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)

    const { close: closeFunction } = await import('./Channel.js')

    // Close function should not have fee budget enforcement
    const result = await closeFunction({
      channel: CHANNEL_ADDRESS,
      amount,
      signature,
      feePayer: { envelopeSigner: signerKp },
    })

    expect(result).toBe('standalone-hash')
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Atomic replay and cumulative protection tests
// ---------------------------------------------------------------------------

describe('atomic challenge replay protection (channel)', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
  })

  it('rejects a second redemption of the same challenge via atomic store.update', async () => {
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    const challenge = Challenge.from({
      id: 'channel-atomic-1',
      realm: 'localhost',
      method: 'stellar',
      intent: 'channel',
      request: {
        amount: '100',
        channel: CHANNEL_ADDRESS,
        methodDetails: {
          reference: crypto.randomUUID(),
          network: 'stellar:testnet',
          cumulativeAmount: '0',
        },
      },
    })

    const amount = '200'
    const signature = COMMITMENT_KEY.sign(Buffer.from('test-commitment-bytes')).toString('hex')

    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { action: 'voucher', amount, signature },
      }),
      { source: 'test-source' },
    )

    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    const result1 = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })
    expect(result1.status).toBe('success')

    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    // Second redemption of same challenge is rejected
    await expect(
      method.verify({
        credential: cred as any,
        request: cred.challenge.request,
      }),
    ).rejects.toThrow('Challenge already used')
  })

  it('enforces cumulative monotonic check atomically via store.update', async () => {
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Initialize cumulative to 100
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, { amount: '100' })

    const challenge = Challenge.from({
      id: 'channel-cumulative-1',
      realm: 'localhost',
      method: 'stellar',
      intent: 'channel',
      request: {
        amount: '50',
        channel: CHANNEL_ADDRESS,
        methodDetails: {
          reference: crypto.randomUUID(),
          network: 'stellar:testnet',
          cumulativeAmount: '100',
        },
      },
    })

    // Try commitment amount (100) that is not strictly greater than previous (100) — should fail
    const amountNotGreater = '100'
    const signatureNotGreater = COMMITMENT_KEY.sign(Buffer.from('test-commitment-bytes')).toString(
      'hex',
    )

    const credNotGreater = Object.assign(
      Credential.from({
        challenge,
        payload: { action: 'voucher', amount: amountNotGreater, signature: signatureNotGreater },
      }),
      { source: 'test-source' },
    )

    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    // This should fail because 150 is not strictly greater than 100
    await expect(
      method.verify({
        credential: credNotGreater as any,
        request: credNotGreater.challenge.request,
      }),
    ).rejects.toThrow('must be greater than previous cumulative')
  })

  it('rejects voucher that does not cover requested amount atomically', async () => {
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Initialize cumulative to 100
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, { amount: '100' })

    const challenge = Challenge.from({
      id: 'channel-coverage-1',
      realm: 'localhost',
      method: 'stellar',
      intent: 'channel',
      request: {
        amount: '50', // requesting 50
        channel: CHANNEL_ADDRESS,
        methodDetails: {
          reference: crypto.randomUUID(),
          network: 'stellar:testnet',
          cumulativeAmount: '100',
        },
      },
    })

    // Commitment of 140 does not cover 100 + 50 = 150, should fail
    const amountInsufficient = '140'
    const signatureInsufficient = COMMITMENT_KEY.sign(
      Buffer.from('test-commitment-bytes'),
    ).toString('hex')

    const credInsufficient = Object.assign(
      Credential.from({
        challenge,
        payload: {
          action: 'voucher',
          amount: amountInsufficient,
          signature: signatureInsufficient,
        },
      }),
      { source: 'test-source' },
    )

    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    await expect(
      method.verify({
        credential: credInsufficient as any,
        request: credInsufficient.challenge.request,
      }),
    ).rejects.toThrow('does not cover the requested amount')
  })

  it('allows voucher with commitment strictly greater than cumulative and covering requested amount', async () => {
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Initialize cumulative to 100
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, { amount: '100' })

    const challenge = Challenge.from({
      id: 'channel-valid-cumulative',
      realm: 'localhost',
      method: 'stellar',
      intent: 'channel',
      request: {
        amount: '50',
        channel: CHANNEL_ADDRESS,
        methodDetails: {
          reference: crypto.randomUUID(),
          network: 'stellar:testnet',
          cumulativeAmount: '100',
        },
      },
    })

    // Commitment of 200 is > 100 and covers 100 + 50 = 150, should succeed
    const amount = '200'
    const signature = COMMITMENT_KEY.sign(Buffer.from('test-commitment-bytes')).toString('hex')

    const cred = Object.assign(
      Credential.from({
        challenge,
        payload: { action: 'voucher', amount, signature },
      }),
      { source: 'test-source' },
    )

    mockSimulateTransaction.mockResolvedValueOnce({
      error: undefined,
      result: { retval: xdr.ScVal.scvBytes(Buffer.from('test-commitment-bytes')) },
      transactionData: new (await import('@stellar/stellar-sdk')).SorobanDataBuilder().build(),
      events: [],
    })

    const result = await method.verify({
      credential: cred as any,
      request: cred.challenge.request,
    })

    expect(result.status).toBe('success')

    // Verify cumulative was updated
    const updated = await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    expect((updated as any).amount).toBe('200')
  })
})
