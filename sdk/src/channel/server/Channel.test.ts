import { Account, Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'

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
        fromXdr: (...args: unknown[]) => mockFromXDR(...args),
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

/** Build a mock Transaction that passes open-XDR validation. */
function mockOpenTx(contractAddress: string = CHANNEL_ADDRESS) {
  const scAddress = Address.fromString(contractAddress).toScAddress()
  return {
    operations: [{ type: 'invokeHostFunction' }],
    toEnvelope: () => ({
      type: 'envelopeTypeTx',
      v1: {
        tx: {
          operations: [
            {
              body: {
                type: 'invokeHostFunction',
                invokeHostFunctionOp: {
                  hostFunction: {
                    type: 'hostFunctionTypeInvokeContract',
                    invokeContract: {
                      contractAddress: scAddress,
                    },
                  },
                },
              },
            },
          ],
        },
      },
    }),
  }
}

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
        type: 'scvBytes',
        value: {
          value: commitmentBytes,
        },
      },
    },
    transactionData: 'mock',
  }
}

/** Build a credential for the open action. */
function makeOpenCredential(opts: {
  transaction: string
  amount: string
  signature?: string
  challengeAmount?: string
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
        cumulativeAmount: '0',
      },
    },
  })
  return Credential.from({
    challenge,
    payload: {
      action: 'open',
      transaction: opts.transaction,
      amount: opts.amount,
      signature: opts.signature ?? 'a'.repeat(128),
    },
  })
}

/** Build a signed open credential with a real ed25519 signature. */
function makeSignedOpenCredential(opts: {
  transaction: string
  commitmentBytes: Buffer
  cumulativeAmount: bigint
  challengeAmount: string
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
        cumulativeAmount: '0',
      },
    },
  })
  return Credential.from({
    challenge,
    payload: {
      action: 'open',
      transaction: opts.transaction,
      amount: opts.cumulativeAmount.toString(),
      signature: sigHex,
    },
  })
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
  it('rejects underpayment (commitment does not cover requested amount)', async () => {
    // Commitment = 500000, but challenge requests 1000000 → should reject
    const credential = makeCredential({
      amount: '500000',
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
    ).rejects.toThrow('does not cover the requested amount')
  })

  it('rejects commitment below previous cumulative', async () => {
    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    await store.put(cumulativeKey, { amount: '5000000' })

    // Commitment = 3000000, previous cumulative = 5000000 → reject
    const credential = makeCredential({
      amount: '3000000',
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
    const credential = makeCredential({
      amount: '5000000',
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

    // Challenge IS claimed as 'pending' (early claim prevents TOCTOU replays)
    const challenge = await store.get(`stellar:channel:challenge:${credential.challenge.id}`)
    expect((challenge as any)?.state).toBe('pending')

    // Cumulative IS advanced eagerly — the commitment signature was validated
    // and can be used for a retry. Writing eagerly allows the cumulative lock
    // to be released before the long on-chain broadcast, preventing DoS.
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

describe('stellar server channel open action', () => {
  it('rejects open action with invalid signature format', async () => {
    const credential = makeOpenCredential({
      transaction: 'AAAA...base64xdr...',
      amount: '1000000',
      signature: 'not-valid-hex!!',
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
    ).rejects.toThrow('Invalid commitment signature')
  })

  it('rejects open action with wrong-length signature', async () => {
    const credential = makeOpenCredential({
      transaction: 'AAAA...base64xdr...',
      amount: '1000000',
      signature: 'abcdef12', // 8 hex chars, need 128
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
    ).rejects.toThrow('Invalid commitment signature')
  })

  it('rejects open action with invalid commitment signature (bad sig)', async () => {
    const commitmentBytes = Buffer.from('open-test-commitment')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeOpenCredential({
      transaction: 'AAAA...base64xdr...',
      amount: '1000000',
      signature: 'ab'.repeat(64), // valid hex, wrong sig
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

  it('accepts valid open credential, broadcasts tx, and initialises store', async () => {
    const commitmentBytes = Buffer.from('open-valid-commitment')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockFromXDR.mockReturnValueOnce(mockOpenTx())
    mockSendTransaction.mockResolvedValueOnce({ hash: 'open-tx-hash-123', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const store = Store.memory()

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    expect(receipt.reference).toBe('open-tx-hash-123')

    // Verify cumulative was initialised in the store
    const stored = (await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)) as {
      amount: string
    }
    expect(stored.amount).toBe('1000000')
  })

  it('rejects open when transaction targets a different contract', async () => {
    const commitmentBytes = Buffer.from('wrong-contract')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    const wrongContract = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
    mockFromXDR.mockReturnValueOnce(mockOpenTx(wrongContract))

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    ).rejects.toThrow('expected')
  })

  it('rejects open when transaction has multiple operations', async () => {
    const commitmentBytes = Buffer.from('multi-op')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    const multiOpTx = {
      operations: [{ type: 'invokeHostFunction' }, { type: 'invokeHostFunction' }],
    }
    mockFromXDR.mockReturnValueOnce(multiOpTx)

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    ).rejects.toThrow('exactly one operation')
  })

  it('rejects open when transaction is not an invokeHostFunction', async () => {
    const commitmentBytes = Buffer.from('wrong-op-type')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    const wrongOpTx = {
      operations: [{ type: 'payment' }],
    }
    mockFromXDR.mockReturnValueOnce(wrongOpTx)

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    ).rejects.toThrow('Soroban invocation')
  })

  it('rejects open when transaction broadcast fails', async () => {
    const commitmentBytes = Buffer.from('open-fail-broadcast')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockFromXDR.mockReturnValueOnce(mockOpenTx())
    mockSendTransaction.mockResolvedValueOnce({ hash: 'fail-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    ).rejects.toThrow('failed')
  })

  it('rejects open when sendTransaction returns TRY_AGAIN_LATER', async () => {
    const commitmentBytes = Buffer.from('open-try-again')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockFromXDR.mockReturnValueOnce(mockOpenTx())
    mockSendTransaction.mockResolvedValueOnce({
      hash: 'try-again-hash',
      status: 'TRY_AGAIN_LATER',
    })

    const credential = makeSignedOpenCredential({
      transaction: 'AAAA...base64xdr...',
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
    ).rejects.toThrow('sendTransaction returned TRY_AGAIN_LATER')
  })
})

// ── close() standalone function ───────────────────────────────────────────────

describe('close()', () => {
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
// TOCTOU race condition tests
// ---------------------------------------------------------------------------

describe('channel TOCTOU: challenge replay across instances sharing a store', () => {
  it('rejects the second concurrent verify when two instances share a store', async () => {
    // Simulate multi-process: two server instances with separate verifyLocks
    // but sharing the same store. A slow RPC (simulateTransaction) widens the
    // TOCTOU window between the challenge check and the challenge mark.
    const sharedStore = Store.memory()
    const commitmentBytes = Buffer.from('toctou-race-bytes')

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
    const commitmentBytes1 = Buffer.from('toctou-cumulative-bytes')

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
