import {
  Account,
  Address,
  Keypair,
  Networks,
  Transaction,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { STELLAR_TESTNET } from '../../constants.js'
import { buildCommitmentMessage } from '../commitment.js'
import { Challenge, Credential, Store } from 'mppx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelVerificationError, SettlementError } from '../../shared/errors.js'
import { PollMaxAttemptsError, TransactionFailedError } from '../../shared/poll.js'

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
const { channel, close, closeWithLatestCommitment, getLatestCommitment } =
  await import('./Channel.js')

// Default: getAccount returns a minimal account stub with a valid public key
const MOCK_SOURCE_KEY = Keypair.random()
mockGetAccount.mockResolvedValue({
  accountId: () => MOCK_SOURCE_KEY.publicKey(),
  sequenceNumber: () => '0',
  sequence: () => '0',
  incrementSequenceNumber: () => {},
})

// Default on-chain state: an open channel with ample balance. Tests asserting a
// specific on-chain condition override this with `mockResolvedValueOnce`. The
// default keeps tests that don't pin a state independent of cross-test mock
// leakage (mocks are not auto-cleared between tests).
const mockHealthyChannelState = () => ({
  balance: 1_000_000_000_000n,
  withdrawn: 0n,
  deposited: 1_000_000_000_000n,
  refundWaitingPeriod: 1000,
  token: 'CTOKEN...',
  from: 'GFROM...',
  to: 'GTO...',
  closeEffectiveAtLedger: null,
  closeStatusLedger: 4000,
  currentLedger: 4000,
})
mockGetChannelState.mockResolvedValue(mockHealthyChannelState())

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
  cumulativeAmount: bigint
  challengeAmount: string
  previousCumulative?: string
}) {
  // The server builds this message locally. A credential is therefore valid
  // only if the client signs the real encoding for its amount. Arbitrary bytes
  // are not sufficient.
  const sig = COMMITMENT_KEY.sign(
    buildCommitmentMessage({
      channel: CHANNEL_ADDRESS,
      amount: opts.cumulativeAmount,
      network: STELLAR_TESTNET,
    }),
  )
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
      withdrawn: 0n,
      deposited: 1000000n,
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

  it('warns when a fee-bump signer is configured without a feeBudget', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random() },
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('feeBudget'))
  })

  it('does not warn about feeBudget when one is configured', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      feePayer: { envelopeSigner: Keypair.random(), feeBumpSigner: Keypair.random() },
      feeBudget: { maxStroops: 20_000_000, windowMs: 60_000 },
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('feeBudget'))
  })

  it('does not warn about feeBudget when no fee-bump signer is configured', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      feePayer: { envelopeSigner: Keypair.random() },
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('feeBudget'))
  })
})

describe('stellar server channel verification', () => {
  beforeEach(() => {
    // Reset first to drop any queued mockResolvedValueOnce left unconsumed by a
    // prior test: cheap monotonicity/coverage rejections now short-circuit before
    // the signature-verify simulate, so a pre-loaded once-value would otherwise
    // leak into the next test. The default is re-established immediately below.
    mockSimulateTransaction.mockReset()
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

  it('verifies the commitment signature before querying on-chain state', async () => {
    // A forged voucher (valid hex, wrong ed25519 signature) must be rejected by
    // the cheap commitment-signature check before the server spends the on-chain
    // state query's RPC calls. Otherwise an attacker holding a fresh challenge
    // could amplify each junk voucher into the full multi-call state read.
    mockGetChannelState.mockResolvedValue({
      balance: 1000000n,
      withdrawn: 0n,
      deposited: 1000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })
    const commitmentBytes = Buffer.from('amplification-guard-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeCredential({
      amount: '1000000',
      challengeAmount: '1000000',
      signature: 'ab'.repeat(64), // 128 hex chars, valid length, invalid signature
    })

    // checkOnChainState defaults to true, so the on-chain read is enabled.
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    // Mocks are not auto-cleared between tests; isolate this assertion to the
    // call (if any) made by the verify() below.
    mockGetChannelState.mockClear()
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toThrow('Commitment signature verification failed')
    expect(mockGetChannelState).not.toHaveBeenCalled()
  })

  it('rejects a non-monotonic commitment before any signature-verify or on-chain-state RPC', async () => {
    // A credential below the stored cumulative cannot advance the channel, so it
    // must be rejected by the cheap monotonicity check before the server spends
    // the signature-verify and on-chain-state RPC calls. Otherwise a flood of
    // stale commitments could amplify into RPC load.
    const store = Store.memory()
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, { amount: '10000' })

    const credential = makeSignedCredential({
      cumulativeAmount: 1000n, // below the stored cumulative of 10000
      challengeAmount: '1000',
      previousCumulative: '10000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    mockSimulateTransaction.mockClear()
    mockGetChannelState.mockClear()

    await expect(
      method.verify({ credential: credential as any, request: credential.challenge.request }),
    ).rejects.toThrow('must be greater than previous cumulative')

    expect(mockSimulateTransaction).not.toHaveBeenCalled()
    expect(mockGetChannelState).not.toHaveBeenCalled()
  })

  it('accepts valid commitment and updates cumulative in store', async () => {
    const commitmentBytes = Buffer.from('valid-commitment-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory()
    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`

    const credential = makeSignedCredential({
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

  it('does not brick a voucher-only channel when a close credential is rejected', async () => {
    // Persistent simulate mock with shared bytes — both credentials sign these.
    const commitmentBytes = Buffer.from('p25-voucher-only')
    mockSimulateTransaction.mockResolvedValue(successSimResult(commitmentBytes))

    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    // Close is rejected because no envelope signer is configured.
    const closeCred = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })
    await expect(
      method.verify({ credential: closeCred as any, request: closeCred.challenge.request }),
    ).rejects.toThrow('Close action requires a feePayer')

    // No closing latch should have been written.
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toBeNull()

    // A subsequent voucher still succeeds — the channel was not left closing.
    const voucherCred = makeSignedCredential({
      action: 'voucher',
      cumulativeAmount: 2000000n,
      challengeAmount: '2000000',
    })
    const receipt = await method.verify({
      credential: voucherCred as any,
      request: voucherCred.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('keeps the closing latch when settlement fails before broadcast', async () => {
    const commitmentBytes = Buffer.from('p25-latch')
    mockSimulateTransaction.mockResolvedValue(successSimResult(commitmentBytes))
    mockPrepareTransaction.mockReset()
    mockPrepareTransaction.mockRejectedValueOnce(new Error('pre-broadcast failure'))
    const sendsBefore = mockSendTransaction.mock.calls.length

    const signerKp = Keypair.random()
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store,
    })

    // Close passes validation but settlement fails before broadcast.
    const closeCred = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })
    await expect(
      method.verify({ credential: closeCred as any, request: closeCred.challenge.request }),
    ).rejects.toThrow('pre-broadcast failure')
    expect(mockSendTransaction.mock.calls.length).toBe(sendsBefore)

    // Closing is final: the latch and the pair stay for a later close.
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toEqual({
      amount: '5000000',
      signature: closeCred.payload.signature,
      closing: true,
    })
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 5000000n,
      signature: Buffer.from(closeCred.payload.signature, 'hex'),
    })

    // A subsequent voucher is rejected.
    const voucherCred = makeSignedCredential({
      action: 'voucher',
      cumulativeAmount: 6000000n,
      challengeAmount: '1000000',
    })
    await expect(
      method.verify({ credential: voucherCred as any, request: voucherCred.challenge.request }),
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Channel is closing — no further credentials accepted.',
        { channel: CHANNEL_ADDRESS },
      ),
    )

    // closeWithLatestCommitment completes the close with the stored pair.
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '50'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'latched-close-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })
    await expect(
      closeWithLatestCommitment({
        store,
        channel: CHANNEL_ADDRESS,
        feePayer: { envelopeSigner: signerKp },
      }),
    ).resolves.toBe('latched-close-hash')
    expect(mockSendTransaction.mock.calls.length).toBe(sendsBefore + 1)
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
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 5000000n,
      signature: Buffer.from(credential.payload.signature, 'hex'),
    })
  })

  it('rejects close with a logged SettlementError when sendTransaction returns non-PENDING status', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-reject-bytes')
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '51'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'err-hash', status: 'ERROR' })

    const credential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store: Store.memory(),
      logger,
    })

    const error = await method
      .verify({
        credential: credential as any,
        request: credential.challenge.request,
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).message).toBe(
      '[stellar:channel] Close broadcast failed: sendTransaction returned ERROR.',
    )
    expect(logger.error).toHaveBeenCalledWith(
      '[stellar:channel] Close broadcast failed: sendTransaction returned ERROR.',
      { hash: 'err-hash', status: 'ERROR' },
    )
  })

  it('rejects close with a SettlementError when sendTransaction throws', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-send-throws')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '51'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockRejectedValueOnce(new Error('RPC down'))

    const credential = makeSignedCredential({
      action: 'close',
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

    const error = await method
      .verify({
        credential: credential as any,
        request: credential.challenge.request,
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).message).toBe(
      '[stellar:channel] Close broadcast failed: could not broadcast transaction.',
    )
    expect((error as SettlementError).details).toEqual({ details: 'RPC down' })
  })

  it('rejects close when sendTransaction returns TRY_AGAIN_LATER', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-tryagain-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '52'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'try-hash', status: 'TRY_AGAIN_LATER' })
    const sendsBefore = mockSendTransaction.mock.calls.length

    const credential = makeSignedCredential({
      action: 'close',
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

    const error = await method
      .verify({
        credential: credential as any,
        request: credential.challenge.request,
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).message).toBe(
      '[stellar:channel] Close broadcast failed: sendTransaction returned TRY_AGAIN_LATER.',
    )
    expect(mockSendTransaction.mock.calls.length).toBe(sendsBefore + 1)
  })

  it('rejects close with a SettlementError that keeps the on-chain failure out of the message', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-poll-fail')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '53'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'poll-fail-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED', resultXdr: 'some-error' })

    const credential = makeSignedCredential({
      action: 'close',
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

    const error = await method
      .verify({
        credential: credential as any,
        request: credential.challenge.request,
      })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).message).toBe(
      '[stellar:channel] Close transaction failed on-chain.',
    )
    expect((error as SettlementError).details).toEqual({
      hash: 'poll-fail-hash',
      details: 'Transaction poll-fail-hash failed: some-error',
    })
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
    mockSendTransaction.mockRejectedValueOnce(new Error('RPC down'))

    const store = Store.memory()
    const credential = makeSignedCredential({
      action: 'close',
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

    // Cumulative IS advanced eagerly, with the closing latch — the commitment
    // signature was validated and closeWithLatestCommitment can complete the
    // close with it. Writing eagerly allows the cumulative lock to be released
    // before the long on-chain broadcast, so unrelated work is not blocked on
    // the network round trip.
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toEqual({
      amount: '5000000',
      signature: credential.payload.signature,
      closing: true,
    })
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 5000000n,
      signature: Buffer.from(credential.payload.signature, 'hex'),
    })
  })
})

describe('stellar server channel dispute detection', () => {
  it.each([
    { reason: 'pending', closeEffectiveAtLedger: 6000 },
    // A close that lands between the latest-ledger read and the status read.
    { reason: 'effective at the status ledger', closeEffectiveAtLedger: 5501 },
    { reason: 'already effective', closeEffectiveAtLedger: 5000 },
  ])('rejects voucher when a close is $reason on-chain', async ({ closeEffectiveAtLedger }) => {
    mockGetChannelState.mockResolvedValueOnce({
      ...mockHealthyChannelState(),
      closeEffectiveAtLedger,
      closeStatusLedger: 5501,
      currentLedger: 5500,
    })

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
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
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Channel is closing on-chain: a close has started.',
        { closeEffectiveAtLedger: String(closeEffectiveAtLedger), closeStatusLedger: '5501' },
      ),
    )
  })

  it('calls onDisputeDetected and rejects the voucher when close_start is pending', async () => {
    const disputeState = {
      ...mockHealthyChannelState(),
      balance: 1000000n,
      deposited: 1000000n,
      closeEffectiveAtLedger: 6000,
      closeStatusLedger: 5501,
      currentLedger: 5500, // before effective: the waiting period is running
    }
    mockGetChannelState.mockResolvedValueOnce(disputeState)

    const commitmentBytes = Buffer.from('dispute-test-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const onDisputeDetected = vi.fn()
    const store = Store.memory()

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      checkOnChainState: true,

      onDisputeDetected,
      store,
    })

    // The channel is ending, so the voucher is rejected right after the callback.
    await expect(
      method.verify({
        credential: credential as any,
        request: credential.challenge.request,
      }),
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Channel is closing on-chain: a close has started.',
        { closeEffectiveAtLedger: '6000', closeStatusLedger: '5501' },
      ),
    )
    expect(onDisputeDetected.mock.calls).toEqual([[disputeState]])
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toBeNull()
  })

  it('rejects voucher when on-chain check fails (network error)', async () => {
    mockGetChannelState.mockRejectedValueOnce(new Error('network timeout'))

    const commitmentBytes = Buffer.from('network-error-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
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
      withdrawn: 0n,
      deposited: 5000000n,
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

    expect(await store.get(`stellar:channel:state:${CHANNEL_ADDRESS}`)).toEqual({
      balance: '5000000',
      withdrawn: '0',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
      queriedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('skips on-chain check when checkOnChainState is false', async () => {
    mockGetChannelState.mockClear()

    const commitmentBytes = Buffer.from('skip-check-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
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

    const commitmentBytes = Buffer.from('non-error-throw-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
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
      withdrawn: 0n,
      deposited: 5000000n,
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

  it('passes through when commitment is within the deposit (balance plus withdrawn)', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 3000000n,
      withdrawn: 2000000n,
      deposited: 5000000n,
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
      cumulativeAmount: 5000000n, // exactly at the deposit, above the balance
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

  it('rejects commitment that exceeds the on-chain deposit', async () => {
    mockGetChannelState.mockResolvedValueOnce({
      balance: 500000n, // less than commitment
      withdrawn: 0n,
      deposited: 500000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    })

    const commitmentBytes = Buffer.from('exceeds-balance-bytes')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
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
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Commitment 1000000 exceeds channel deposit 500000.',
        { commitmentAmount: '1000000', deposited: '500000' },
      ),
    )
  })
})

// ── close() standalone function ───────────────────────────────────────────────

describe('channel server keeps the latest commitment for recipient close', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockGetChannelState.mockReset()
    mockGetChannelState.mockResolvedValue(mockHealthyChannelState())
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  function setup() {
    const store = Store.memory()
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
    })
    return { store, method }
  }

  async function acceptVoucher(method: ReturnType<typeof channel>, amount: bigint) {
    const commitmentBytes = Buffer.from(`commitment-${amount}`)
    const credential = makeSignedCredential({
      cumulativeAmount: amount,
      challengeAmount: '100',
    })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    await method.verify({ credential: credential as any, request: credential.challenge.request })
    return credential
  }

  it('stores the exact amount and signature together after one accepted voucher', async () => {
    const { store, method } = setup()
    const credential = await acceptVoucher(method, 100n)

    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toEqual({
      amount: '100',
      signature: credential.payload.signature,
    })
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 100n,
      signature: Buffer.from(credential.payload.signature, 'hex'),
    })
  })

  it('replaces both amount and signature with the second accepted voucher', async () => {
    const { store, method } = setup()
    const first = await acceptVoucher(method, 100n)
    const second = await acceptVoucher(method, 200n)

    expect(second.payload.signature).not.toBe(first.payload.signature)
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 200n,
      signature: Buffer.from(second.payload.signature, 'hex'),
    })
  })

  it('does not change the stored pair after a non-monotonic voucher is rejected', async () => {
    const { store, method } = setup()
    const accepted = await acceptVoucher(method, 100n)
    const rejected = makeSignedCredential({
      cumulativeAmount: 100n,
      challengeAmount: '100',
    })

    await expect(
      method.verify({ credential: rejected as any, request: rejected.challenge.request }),
    ).rejects.toThrow('must be greater than previous cumulative')
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 100n,
      signature: Buffer.from(accepted.payload.signature, 'hex'),
    })
  })

  it('returns null for an empty store', async () => {
    expect(
      await getLatestCommitment({ store: Store.memory(), channel: CHANNEL_ADDRESS }),
    ).toBeNull()
  })

  it('returns null for a legacy record until the next accepted voucher', async () => {
    const { store, method } = setup()
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, { amount: '100' })
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toBeNull()

    const credential = await acceptVoucher(method, 200n)
    expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
      amount: 200n,
      signature: Buffer.from(credential.payload.signature, 'hex'),
    })
  })

  it.each(
    ['not-a-number', '0', '01', '-1', '170141183460469231731687303715884105728', 100, ['100']].map(
      (amount) => ({ amount }),
    ),
  )('throws ChannelVerificationError for malformed stored amount $amount', async ({ amount }) => {
    const store = Store.memory()
    await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, {
      amount,
      signature: 'ab'.repeat(64),
    })
    await expect(getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).rejects.toEqual(
      new ChannelVerificationError('[stellar:channel] Stored commitment record is malformed.', {
        channel: CHANNEL_ADDRESS,
      }),
    )
  })

  it.each(['', 'ab'.repeat(63), 'ab'.repeat(65), 'gg'.repeat(64), null, 123])(
    'throws ChannelVerificationError for malformed stored signature %j',
    async (signature) => {
      const store = Store.memory()
      await store.put(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`, {
        amount: '100',
        signature,
      })
      await expect(getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).rejects.toEqual(
        new ChannelVerificationError('[stellar:channel] Stored commitment record is malformed.', {
          channel: CHANNEL_ADDRESS,
        }),
      )
    },
  )

  it('passes the exact stored pair to the standalone close contract call', async () => {
    const { store, method } = setup()
    const credential = await acceptVoucher(method, 100n)
    const latest = await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })
    expect(latest).toEqual({
      amount: 100n,
      signature: Buffer.from(credential.payload.signature, 'hex'),
    })
    if (!latest) throw new Error('Expected a stored commitment')

    const signer = Keypair.random()
    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '100'))
    mockPrepareTransaction.mockImplementationOnce((tx: Transaction) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'latest-close-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    expect(
      await close({
        channel: CHANNEL_ADDRESS,
        ...latest,
        feePayer: { envelopeSigner: signer },
      }),
    ).toBe('latest-close-hash')
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
    const tx = mockSendTransaction.mock.calls[0]![0] as Transaction
    const op = tx.operations[0]!
    if (op.type !== 'invokeHostFunction') throw new Error('Expected contract invocation')
    const invocation = op.func.invokeContract()
    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(CHANNEL_ADDRESS)
    expect(invocation.functionName().toString()).toBe('close')
    expect(invocation.args()).toEqual([
      nativeToScVal(100n, { type: 'i128' }),
      nativeToScVal(Buffer.from(credential.payload.signature, 'hex'), { type: 'bytes' }),
    ])
  })

  it('keeps the close credential pair while settlement is pending', async () => {
    const store = Store.memory()
    const signer = Keypair.random()
    const commitmentBytes = Buffer.from('pending-close-commitment')
    const credential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 200n,
      challengeAmount: '100',
    })
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signer },
      store,
    })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signer.publicKey(), '100'))
    mockPrepareTransaction.mockImplementationOnce(async (tx: Transaction) => {
      expect(await getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).toEqual({
        amount: 200n,
        signature: Buffer.from(credential.payload.signature, 'hex'),
      })
      return tx
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'pending-close-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    expect(receipt.reference).toBe('pending-close-hash')
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('closeWithLatestCommitment', () => {
  const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
  const closedKey = `stellar:channel:closed:${CHANNEL_ADDRESS}`
  const closeSendsKey = `stellar:channel:closeSends:${CHANNEL_ADDRESS}`
  const now = '2026-10-06T12:00:00.000Z'
  const closingError = new ChannelVerificationError(
    '[stellar:channel] Channel is closing — no further credentials accepted.',
    { channel: CHANNEL_ADDRESS },
  )
  const closedError = new ChannelVerificationError(
    '[stellar:channel] Channel has been closed. No further credentials accepted.',
    { channel: CHANNEL_ADDRESS },
  )
  const sendRejected = (status: string) =>
    new ChannelVerificationError(
      `[stellar:channel] Close broadcast failed: sendTransaction returned ${status}.`,
      { hash: 'stored-close-hash', status },
    )

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
    mockSimulateTransaction.mockReset()
    mockGetChannelState.mockReset()
    mockGetChannelState.mockResolvedValue(mockHealthyChannelState())
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockPrepareTransaction.mockImplementation((tx: Transaction) => tx)
    mockSendTransaction.mockReset()
    mockSendTransaction.mockResolvedValue({ hash: 'stored-close-hash', status: 'PENDING' })
    mockGetTransaction.mockReset()
    mockGetTransaction.mockResolvedValue({ status: 'SUCCESS' })
    mockWrapFeeBump.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    mockSimulateTransaction.mockReset()
  })

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  function setup(onDisputeDetected?: () => void) {
    const store = Store.memory()
    const signer = Keypair.random()
    mockGetAccount.mockResolvedValue(new Account(signer.publicKey(), '100'))
    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
      onDisputeDetected,
    })
    const parameters = {
      store,
      channel: CHANNEL_ADDRESS,
      feePayer: { envelopeSigner: signer },
    }
    return { store, method, parameters }
  }

  function voucher(amount: bigint) {
    const commitmentBytes = Buffer.from(`stored-close-commitment-${amount}`)
    const credential = makeSignedCredential({
      cumulativeAmount: amount,
      challengeAmount: '100',
    })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    return { credential: credential as any, request: credential.challenge.request }
  }

  function storedPair(input: ReturnType<typeof voucher>) {
    return {
      amount: input.credential.payload.amount,
      signature: input.credential.payload.signature,
    }
  }

  /** On-chain state after `withdrawn` has been paid out to the recipient. */
  function withdrawnState(withdrawn: bigint) {
    const healthy = mockHealthyChannelState()
    return { ...healthy, withdrawn, balance: healthy.balance - withdrawn }
  }

  /** Every send so far was `close(amount, signature)` for the given voucher. */
  function expectCloseArgs(input: ReturnType<typeof voucher>, sends = 1) {
    expect(mockSendTransaction).toHaveBeenCalledTimes(sends)
    for (const [sent] of mockSendTransaction.mock.calls) {
      const tx = sent as Transaction
      const op = tx.operations[0]!
      if (op.type !== 'invokeHostFunction') throw new Error('Expected contract invocation')
      const invocation = op.func.invokeContract()
      expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(CHANNEL_ADDRESS)
      expect(invocation.functionName().toString()).toBe('close')
      expect(invocation.args()).toEqual([
        nativeToScVal(BigInt(input.credential.payload.amount), { type: 'i128' }),
        nativeToScVal(Buffer.from(input.credential.payload.signature, 'hex'), { type: 'bytes' }),
      ])
    }
  }

  it('closes with the accepted pair, records closure, and rejects later vouchers', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)

    expect(await closeWithLatestCommitment(parameters)).toBe('stored-close-hash')
    expectCloseArgs(accepted)
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
    expect(await store.get(closedKey)).toEqual({
      closedAt: now,
      txHash: 'stored-close-hash',
      amount: '100',
    })
    expect(await store.get(closeSendsKey)).toEqual({ count: 1 })
    await expect(method.verify(voucher(200n))).rejects.toEqual(closedError)
  })

  it('returns null without sending when the stored amount is already withdrawn', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    mockGetChannelState.mockResolvedValueOnce(withdrawnState(100n))
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    expect(await closeWithLatestCommitment({ ...parameters, logger })).toBeNull()
    expect(mockSendTransaction).toHaveBeenCalledTimes(0)
    expect(mockGetAccount).toHaveBeenCalledTimes(0)
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
    expect(await store.get(closedKey)).toEqual({ closedAt: now, amount: '100' })
    expect(await store.get(closeSendsKey)).toBeNull()
    expect(logger.info.mock.calls).toEqual([
      [
        '[stellar:channel] Stored commitment already withdrawn on-chain; nothing to send.',
        { channel: CHANNEL_ADDRESS, amount: '100', withdrawn: '100' },
      ],
    ])
    await expect(method.verify(voucher(200n))).rejects.toEqual(closedError)
  })

  it('rejects an in-flight voucher on another instance once the pair is selected', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    const other = channel({ channel: CHANNEL_ADDRESS, commitmentKey: COMMITMENT_KEY, store })
    const pending = voucher(200n)

    // The voucher's on-chain read is in flight while the helper selects the pair.
    const stateReadStarted = deferred<void>()
    const stateRead = deferred<ReturnType<typeof mockHealthyChannelState>>()
    mockGetChannelState.mockImplementationOnce(() => {
      stateReadStarted.resolve()
      return stateRead.promise
    })
    const verification = other.verify(pending)
    await stateReadStarted.promise

    // Hold the helper right after its atomic selection and chain read.
    const selected = deferred<void>()
    const releaseHelper = deferred<void>()
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation((async (key: string, fn: any) => {
      if (key === closeSendsKey) {
        selected.resolve()
        await releaseHelper.promise
      }
      return update(key, fn)
    }) as any)
    const closing = closeWithLatestCommitment(parameters)
    await selected.promise
    stateRead.resolve(mockHealthyChannelState())
    try {
      await expect(verification).rejects.toEqual(closingError)
      expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
    } finally {
      releaseHelper.resolve()
      expect(await closing).toBe('stored-close-hash')
    }
    expectCloseArgs(accepted)
  })

  it('rejects the triggering voucher and closes with the stored pair from onDisputeDetected', async () => {
    let closing: Promise<string | null> | undefined
    const { store, method, parameters } = setup(() => {
      closing = closeWithLatestCommitment(parameters)
    })
    const accepted = voucher(100n)
    await method.verify(accepted)
    mockGetChannelState.mockResolvedValueOnce({
      ...mockHealthyChannelState(),
      closeEffectiveAtLedger: 5000,
    })

    await expect(method.verify(voucher(200n))).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Channel is closing on-chain: a close has started.',
        { closeEffectiveAtLedger: '5000', closeStatusLedger: '4000' },
      ),
    )
    if (!closing) throw new Error('Expected onDisputeDetected to start the close')
    expect(await closing).toBe('stored-close-hash')
    expectCloseArgs(accepted)
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
  })

  it('returns null when a credential close lands between the selection and the chain read', async () => {
    const { store, method, parameters } = setup()
    await method.verify(voucher(100n))
    const other = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
      feePayer: parameters.feePayer,
    })
    const commitmentBytes = Buffer.from('credential-close-200')
    const credential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 200n,
      challengeAmount: '100',
    })
    const input = { credential: credential as any, request: credential.challenge.request }
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockSendTransaction.mockResolvedValueOnce({ hash: 'credential-close-hash', status: 'PENDING' })

    // Hold the helper's selection until the credential close has completed.
    const selectionStarted = deferred<void>()
    const releaseSelection = deferred<void>()
    const update = store.update.bind(store)
    let held = false
    vi.spyOn(store, 'update').mockImplementation((async (key: string, fn: any) => {
      if (key === cumulativeKey && !held) {
        held = true
        selectionStarted.resolve()
        await releaseSelection.promise
      }
      return update(key, fn)
    }) as any)

    const closing = closeWithLatestCommitment(parameters)
    await selectionStarted.promise
    expect((await other.verify(input)).reference).toBe('credential-close-hash')
    expect(await store.get(closedKey)).toEqual({
      closedAt: now,
      txHash: 'credential-close-hash',
      amount: '200',
    })

    // The chain shows the credential close's amount withdrawn, so nothing is sent.
    mockGetChannelState.mockResolvedValueOnce(withdrawnState(200n))
    releaseSelection.resolve()
    expect(await closing).toBeNull()
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(input), closing: true })
  })

  it('rejects an in-flight close credential when the helper selection commits first', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    const other = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store,
      feePayer: parameters.feePayer,
    })
    const commitmentBytes = Buffer.from('credential-close-200')
    const credential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 200n,
      challengeAmount: '100',
    })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const updateStarted = deferred<void>()
    const releaseUpdate = deferred<void>()
    const update = store.update.bind(store)
    let held = false
    vi.spyOn(store, 'update').mockImplementation((async (key: string, fn: any) => {
      if (key === cumulativeKey && !held) {
        held = true
        updateStarted.resolve()
        await releaseUpdate.promise
      }
      return update(key, fn)
    }) as any)
    const prepareStarted = deferred<void>()
    const releasePrepare = deferred<void>()
    mockPrepareTransaction.mockImplementationOnce(async (tx: Transaction) => {
      prepareStarted.resolve()
      await releasePrepare.promise
      return tx
    })

    const verification = other.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    const rejected = expect(verification).rejects.toEqual(closingError)
    await updateStarted.promise
    const closing = closeWithLatestCommitment(parameters)
    await prepareStarted.promise
    try {
      releaseUpdate.resolve()
      await rejected
      expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
      expect(mockSendTransaction).toHaveBeenCalledTimes(0)
    } finally {
      releaseUpdate.resolve()
      releasePrepare.resolve()
      expect(await closing).toBe('stored-close-hash')
    }
    expectCloseArgs(accepted)
  })

  it('lets two concurrent helper calls both complete', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)

    const [first, second] = await Promise.all([
      closeWithLatestCommitment(parameters),
      closeWithLatestCommitment(parameters),
    ])
    expect(first).toBe('stored-close-hash')
    expect(second).toBe('stored-close-hash')
    // The second send pays nothing on-chain: the contract pays only what is not yet withdrawn.
    expectCloseArgs(accepted, 2)
    expect(await store.get(closeSendsKey)).toEqual({ count: 2 })
    expect(await store.get(closedKey)).toEqual({
      closedAt: now,
      txHash: 'stored-close-hash',
      amount: '100',
    })
  })

  it.each([
    { record: null, message: 'No stored commitment to close with' },
    { record: { amount: '100' }, message: 'No stored commitment to close with' },
    ...['', 'ab'.repeat(63), 'ab'.repeat(65), 'gg'.repeat(64), null, 123].map((signature) => ({
      record: { amount: '100', signature },
      message: 'Stored commitment record is malformed.',
    })),
    ...['not-a-number', 100, ['100']].map((amount) => ({
      record: { amount, signature: 'ab'.repeat(64) },
      message: 'Stored commitment record is malformed.',
    })),
  ])('leaves the record unchanged when selection fails: $record', async ({ record, message }) => {
    const { store, parameters } = setup()
    if (record) await store.put(cumulativeKey, record)
    const put = vi.spyOn(store, 'put')
    const remove = vi.spyOn(store, 'delete')
    await expect(closeWithLatestCommitment(parameters)).rejects.toEqual(
      new ChannelVerificationError(`[stellar:channel] ${message}`, { channel: CHANNEL_ADDRESS }),
    )
    expect(await store.get(cumulativeKey)).toEqual(record)
    expect(put).toHaveBeenCalledTimes(0)
    expect(remove).toHaveBeenCalledTimes(0)
    expect(mockGetChannelState).toHaveBeenCalledTimes(0)
    expect(mockSendTransaction).toHaveBeenCalledTimes(0)
  })

  it('rejects a store without atomic update before writing the latch', async () => {
    const { store, parameters } = setup()
    const put = vi.spyOn(store, 'put')
    await expect(
      closeWithLatestCommitment({
        ...parameters,
        // Cast mirrors a JavaScript caller passing a store without update().
        store: { get: store.get, put: store.put, delete: store.delete } as Store.AtomicStore,
      }),
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] An atomic store providing compare-and-set semantics via update() is required for closing with the stored commitment.',
        { channel: CHANNEL_ADDRESS },
      ),
    )
    expect(put).toHaveBeenCalledTimes(0)
  })

  it('returns null for an already closed channel without any store writes', async () => {
    const { store, parameters } = setup()
    await store.put(closedKey, { closedAt: now, txHash: 'earlier-close', amount: '100' })
    const put = vi.spyOn(store, 'put')
    const update = vi.spyOn(store, 'update')
    const remove = vi.spyOn(store, 'delete')
    await expect(closeWithLatestCommitment(parameters)).resolves.toBeNull()
    expect(put).toHaveBeenCalledTimes(0)
    expect(update).toHaveBeenCalledTimes(0)
    expect(remove).toHaveBeenCalledTimes(0)
    expect(mockSendTransaction).toHaveBeenCalledTimes(0)
  })

  it('wraps the close in a fee bump when feeBumpSigner is set', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    const feeBumpSigner = Keypair.random()
    const bumpedTx = { bumped: true }
    mockWrapFeeBump.mockReturnValueOnce(bumpedTx)

    await expect(
      closeWithLatestCommitment({
        ...parameters,
        feePayer: { ...parameters.feePayer, feeBumpSigner },
        maxFeeBumpStroops: 12345,
      }),
    ).resolves.toBe('stored-close-hash')
    expect(mockWrapFeeBump).toHaveBeenCalledTimes(1)
    const [innerTx, bumpKeypair, options] = mockWrapFeeBump.mock.calls[0]! as [
      Transaction,
      Keypair,
      { networkPassphrase: string; maxFeeStroops: number },
    ]
    const invocation = innerTx.operations[0]!
    if (invocation.type !== 'invokeHostFunction') throw new Error('Expected contract invocation')
    expect(invocation.func.invokeContract().functionName().toString()).toBe('close')
    expect(bumpKeypair.publicKey()).toBe(feeBumpSigner.publicKey())
    expect(options).toEqual({ networkPassphrase: innerTx.networkPassphrase, maxFeeStroops: 12345 })
    expect(mockSendTransaction.mock.calls).toEqual([[bumpedTx]])
    expect(await store.get(closedKey)).toEqual({
      closedAt: now,
      txHash: 'stored-close-hash',
      amount: '100',
    })
  })

  it('keeps the latch when the close fails before broadcast and completes on the next call', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    const error = new Error('prepare failed')
    mockPrepareTransaction.mockRejectedValueOnce(error)

    await expect(closeWithLatestCommitment(parameters)).rejects.toBe(error)
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
    expect(await store.get(closedKey)).toBeNull()
    // A close that never reached the network does not use up the send cap.
    expect(await store.get(closeSendsKey)).toBeNull()
    expect(mockSendTransaction).toHaveBeenCalledTimes(0)
    await expect(method.verify(voucher(200n))).rejects.toEqual(closingError)

    await expect(closeWithLatestCommitment(parameters)).resolves.toBe('stored-close-hash')
    expectCloseArgs(accepted)
    expect(await store.get(closeSendsKey)).toEqual({ count: 1 })
    expect(await store.get(closedKey)).toEqual({
      closedAt: now,
      txHash: 'stored-close-hash',
      amount: '100',
    })
  })

  it.each(['ERROR', 'TRY_AGAIN_LATER', 'FAILED'] as const)(
    'keeps the latch after a close ending in %s and sends again on the next call',
    async (failure) => {
      const { store, method, parameters } = setup()
      const accepted = voucher(100n)
      await method.verify(accepted)
      let error: Error
      if (failure === 'FAILED') {
        mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })
        error = new TransactionFailedError('Transaction stored-close-hash failed: unknown error')
      } else {
        mockSendTransaction.mockResolvedValueOnce({ hash: 'stored-close-hash', status: failure })
        error = sendRejected(failure)
      }

      await expect(closeWithLatestCommitment(parameters)).rejects.toEqual(error)
      expectCloseArgs(accepted)
      expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
      expect(await store.get(closedKey)).toBeNull()
      expect(await store.get(closeSendsKey)).toEqual({ count: 1 })
      await expect(method.verify(voucher(200n))).rejects.toEqual(closingError)

      await expect(closeWithLatestCommitment(parameters)).resolves.toBe('stored-close-hash')
      expectCloseArgs(accepted, 2)
      expect(await store.get(closeSendsKey)).toEqual({ count: 2 })
      expect(await store.get(closedKey)).toEqual({
        closedAt: now,
        txHash: 'stored-close-hash',
        amount: '100',
      })
    },
  )

  it.each(['throw', 'DUPLICATE', 'poll limit'] as const)(
    'keeps the latch when the close outcome is unknown (%s) and returns null once the chain shows it landed',
    async (failure) => {
      const { store, method, parameters } = setup()
      const accepted = voucher(100n)
      await method.verify(accepted)
      let error: Error
      if (failure === 'throw') {
        error = new Error('send failed')
        mockSendTransaction.mockRejectedValueOnce(error)
      } else if (failure === 'DUPLICATE') {
        mockSendTransaction.mockResolvedValueOnce({
          hash: 'stored-close-hash',
          status: 'DUPLICATE',
        })
        error = sendRejected('DUPLICATE')
      } else {
        mockGetTransaction.mockResolvedValueOnce({ status: 'NOT_FOUND' })
        error = new PollMaxAttemptsError('Transaction stored-close-hash not found after 1 attempts')
      }

      await expect(
        closeWithLatestCommitment({ ...parameters, pollMaxAttempts: 1, pollDelayMs: 0 }),
      ).rejects.toEqual(error)
      expectCloseArgs(accepted)
      expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
      expect(await store.get(closedKey)).toBeNull()
      await expect(method.verify(voucher(200n))).rejects.toEqual(closingError)
      await expect(getLatestCommitment({ store, channel: CHANNEL_ADDRESS })).resolves.toEqual({
        amount: 100n,
        signature: Buffer.from(accepted.credential.payload.signature, 'hex'),
      })

      // The first close landed after all: the chain shows it, so nothing is resent.
      mockGetChannelState.mockResolvedValueOnce(withdrawnState(100n))
      expect(await closeWithLatestCommitment(parameters)).toBeNull()
      expectCloseArgs(accepted)
      expect(await store.get(closeSendsKey)).toEqual({ count: 1 })
      expect(await store.get(closedKey)).toEqual({ closedAt: now, amount: '100' })
    },
  )

  it('stops sending once the send cap is reached', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    mockSendTransaction.mockResolvedValue({ hash: 'stored-close-hash', status: 'ERROR' })
    const options = { ...parameters, maxCloseSends: 2 }

    await expect(closeWithLatestCommitment(options)).rejects.toEqual(sendRejected('ERROR'))
    await expect(closeWithLatestCommitment(options)).rejects.toEqual(sendRejected('ERROR'))
    expectCloseArgs(accepted, 2)

    await expect(closeWithLatestCommitment(options)).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Close send limit reached: 2 close transactions were already sent for this channel. Reconcile against the chain before sending more.',
        { channel: CHANNEL_ADDRESS, maxCloseSends: '2' },
      ),
    )
    expectCloseArgs(accepted, 2)
    expect(await store.get(closeSendsKey)).toEqual({ count: 2 })
    expect(await store.get(cumulativeKey)).toEqual({ ...storedPair(accepted), closing: true })
    expect(await store.get(closedKey)).toBeNull()

    // The chain check still runs past the cap: a close that landed is recorded without a send.
    mockGetChannelState.mockResolvedValueOnce(withdrawnState(100n))
    expect(await closeWithLatestCommitment(options)).toBeNull()
    expectCloseArgs(accepted, 2)
    expect(await store.get(closedKey)).toEqual({ closedAt: now, amount: '100' })
  })

  it('treats a legacy settling record as closing', async () => {
    const { store, method, parameters } = setup()
    const accepted = voucher(100n)
    await method.verify(accepted)
    const legacy = {
      ...storedPair(accepted),
      settling: true,
      settlingAmount: '100',
      settledAt: now,
    }
    await store.put(cumulativeKey, legacy)

    await expect(method.verify(voucher(200n))).rejects.toEqual(closingError)
    expect(await closeWithLatestCommitment(parameters)).toBe('stored-close-hash')
    expectCloseArgs(accepted)
    expect(await store.get(cumulativeKey)).toEqual(legacy)
  })
})

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
    mockSendTransaction.mockResolvedValueOnce({ hash: 'try-again-hash', status: 'TRY_AGAIN_LATER' })

    await expect(
      closeFn({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature,
        feePayer: { envelopeSigner: signer },
        network: 'stellar:testnet',
      }),
    ).rejects.toEqual(
      new ChannelVerificationError(
        '[stellar:channel] Close broadcast failed: sendTransaction returned TRY_AGAIN_LATER.',
        { hash: 'try-again-hash', status: 'TRY_AGAIN_LATER' },
      ),
    )
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
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
      withdrawn: 0n,
      deposited: 9999999n,
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

describe('channel vouchers after a close credential latches the channel', () => {
  const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
  const closingError = new ChannelVerificationError(
    '[stellar:channel] Channel is closing — no further credentials accepted.',
    { channel: CHANNEL_ADDRESS },
  )

  // Before each test, clear all mocks to prevent cross-test contamination
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockGetTransaction.mockReset()
  })

  it('rejects a voucher on another instance while a close credential is being settled', async () => {
    const store = Store.memory()
    const closeBytes = Buffer.from('close-latch')
    const voucherBytes = Buffer.from('voucher-during-latch')
    mockSimulateTransaction
      .mockResolvedValueOnce(successSimResult(closeBytes))
      .mockResolvedValueOnce(successSimResult(voucherBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(Keypair.random().publicKey(), '200'))
    let prepareStarted!: () => void
    const prepareStartedPromise = new Promise<void>((resolve) => {
      prepareStarted = resolve
    })
    let releasePrepare!: () => void
    const releasePreparePromise = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    mockPrepareTransaction.mockImplementationOnce(async (tx: any) => {
      prepareStarted()
      await releasePreparePromise
      return tx
    })
    mockSendTransaction.mockResolvedValueOnce({ hash: 'close-latch-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const closer = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: Keypair.random() },
      store,
    })
    const voucherVerifier = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store,
    })

    const closeCredential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 100n,
      challengeAmount: '100',
    })
    const closePromise = closer.verify({
      credential: closeCredential as any,
      request: closeCredential.challenge.request,
    })
    await prepareStartedPromise

    // The latch is written with the pair, before the close is even built.
    expect(await store.get(cumulativeKey)).toEqual({
      amount: '100',
      signature: closeCredential.payload.signature,
      closing: true,
    })

    const voucherCredential = makeSignedCredential({
      action: 'voucher',
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
      ).rejects.toEqual(closingError)
    } finally {
      releasePrepare()
      expect((await closePromise).reference).toBe('close-latch-hash')
    }
  })

  it.each(['voucher', 'close'] as const)(
    'rejects a %s credential while the channel is closing',
    async (action) => {
      const store = Store.memory()
      const record = { amount: '5000000', signature: 'ab'.repeat(64), closing: true }
      await store.put(cumulativeKey, record)

      const credential = makeSignedCredential({
        action,
        cumulativeAmount: 6000000n,
        challengeAmount: '1000000',
        previousCumulative: '5000000',
      })

      const method = channel({
        channel: CHANNEL_ADDRESS,
        checkOnChainState: false,
        commitmentKey: COMMITMENT_KEY,
        feePayer: { envelopeSigner: Keypair.random() },
        store,
      })

      await expect(
        method.verify({
          credential: credential as any,
          request: credential.challenge.request,
        }),
      ).rejects.toEqual(closingError)
      expect(await store.get(cumulativeKey)).toEqual(record)
      expect(mockSendTransaction).toHaveBeenCalledTimes(0)
    },
  )

  it('keeps the latch after an unknown close outcome and completes from the chain without resending', async () => {
    const signerKp = Keypair.random()
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(Buffer.from('settlement-fail-test-bytes')),
    )
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '200'))
    mockPrepareTransaction.mockImplementationOnce((tx: any) => tx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'fail-settlement-hash', status: 'PENDING' })
    // Poll never sees the transaction, so the close may still land.
    mockGetTransaction.mockResolvedValueOnce({ status: 'NOT_FOUND' })

    const store = Store.memory()
    const credential = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: signerKp },
      store,
      pollMaxAttempts: 1,
      pollDelayMs: 0,
    })

    const error = await method
      .verify({ credential: credential as any, request: credential.challenge.request })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).message).toBe(
      '[stellar:channel] Close settlement did not confirm — the channel stays closing; closeWithLatestCommitment completes the close.',
    )
    expect((error as SettlementError).details).toEqual({
      hash: 'fail-settlement-hash',
      details: 'Transaction fail-settlement-hash not found after 1 attempts',
    })
    expect(await store.get(cumulativeKey)).toEqual({
      amount: '5000000',
      signature: credential.payload.signature,
      closing: true,
    })

    const voucherCredential = makeSignedCredential({
      action: 'voucher',
      cumulativeAmount: 6000000n,
      challengeAmount: '1000000',
      previousCumulative: '5000000',
    })
    await expect(
      method.verify({
        credential: voucherCredential as any,
        request: voucherCredential.challenge.request,
      }),
    ).rejects.toEqual(closingError)

    // The close landed after all: the chain shows the withdrawal, so nothing is resent.
    mockGetChannelState.mockResolvedValueOnce({ ...mockHealthyChannelState(), withdrawn: 5000000n })
    expect(
      await closeWithLatestCommitment({
        store,
        channel: CHANNEL_ADDRESS,
        feePayer: { envelopeSigner: signerKp },
      }),
    ).toBeNull()
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)
    expect(await store.get(`stellar:channel:closed:${CHANNEL_ADDRESS}`)).toEqual({
      closedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      amount: '5000000',
    })
  })

  describe('close credential failures', () => {
    function setupClose() {
      const signerKp = Keypair.random()
      const store = Store.memory()
      const commitmentBytes = Buffer.from('close-failure-bytes')
      mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
      mockGetAccount.mockResolvedValue(new Account(signerKp.publicKey(), '300'))
      mockPrepareTransaction.mockImplementation((tx: any) => tx)
      const credential = makeSignedCredential({
        action: 'close',
        cumulativeAmount: 5000000n,
        challengeAmount: '5000000',
      })
      const method = channel({
        channel: CHANNEL_ADDRESS,
        checkOnChainState: false,
        commitmentKey: COMMITMENT_KEY,
        feePayer: { envelopeSigner: signerKp },
        store,
        pollMaxAttempts: 1,
        pollDelayMs: 0,
      })
      const verifyClose = () =>
        method.verify({ credential: credential as any, request: credential.challenge.request })
      const verifyVoucher = () => {
        const voucherBytes = Buffer.from('voucher-after-close-failure')
        mockSimulateTransaction.mockResolvedValueOnce(successSimResult(voucherBytes))
        const voucherCredential = makeSignedCredential({
          action: 'voucher',
          cumulativeAmount: 6000000n,
          challengeAmount: '1000000',
          previousCumulative: '5000000',
        })
        return method.verify({
          credential: voucherCredential as any,
          request: voucherCredential.challenge.request,
        })
      }
      const completeClose = () =>
        closeWithLatestCommitment({
          store,
          channel: CHANNEL_ADDRESS,
          feePayer: { envelopeSigner: signerKp },
        })
      return { store, credential, verifyClose, verifyVoucher, completeClose }
    }

    it.each([
      {
        failure: 'ERROR',
        message: '[stellar:channel] Close broadcast failed: sendTransaction returned ERROR.',
      },
      {
        failure: 'TRY_AGAIN_LATER',
        message:
          '[stellar:channel] Close broadcast failed: sendTransaction returned TRY_AGAIN_LATER.',
      },
      { failure: 'FAILED', message: '[stellar:channel] Close transaction failed on-chain.' },
    ])(
      'keeps the channel closing after a close ending in $failure',
      async ({ failure, message }) => {
        const { store, credential, verifyClose, verifyVoucher, completeClose } = setupClose()
        if (failure === 'FAILED') {
          mockSendTransaction.mockResolvedValueOnce({ hash: 'close-hash', status: 'PENDING' })
          mockGetTransaction.mockResolvedValueOnce({ status: 'FAILED' })
        } else {
          mockSendTransaction.mockResolvedValueOnce({ hash: 'close-hash', status: failure })
        }

        const error = await verifyClose().catch((e: unknown) => e)
        expect(error).toBeInstanceOf(SettlementError)
        expect((error as SettlementError).message).toBe(message)
        expect(mockSendTransaction).toHaveBeenCalledTimes(1)
        expect(await store.get(cumulativeKey)).toEqual({
          amount: '5000000',
          signature: credential.payload.signature,
          closing: true,
        })
        await expect(verifyVoucher()).rejects.toEqual(closingError)

        // closeWithLatestCommitment completes the close with the same pair.
        mockSendTransaction.mockResolvedValueOnce({ hash: 'retry-close-hash', status: 'PENDING' })
        mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })
        await expect(completeClose()).resolves.toBe('retry-close-hash')
        expect(mockSendTransaction).toHaveBeenCalledTimes(2)
        expect(await store.get(`stellar:channel:closed:${CHANNEL_ADDRESS}`)).toEqual({
          closedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          txHash: 'retry-close-hash',
          amount: '5000000',
        })
      },
    )

    it.each([
      {
        failure: 'throw',
        message: '[stellar:channel] Close broadcast failed: could not broadcast transaction.',
      },
      {
        failure: 'DUPLICATE',
        message: '[stellar:channel] Close broadcast failed: sendTransaction returned DUPLICATE.',
      },
      {
        failure: 'poll limit',
        message:
          '[stellar:channel] Close settlement did not confirm — the channel stays closing; closeWithLatestCommitment completes the close.',
      },
    ])(
      'keeps the channel closing when the close outcome is unknown ($failure)',
      async ({ failure, message }) => {
        const { store, credential, verifyClose, verifyVoucher } = setupClose()
        if (failure === 'throw') {
          mockSendTransaction.mockRejectedValueOnce(new Error('RPC down'))
        } else if (failure === 'DUPLICATE') {
          mockSendTransaction.mockResolvedValueOnce({ hash: 'close-hash', status: 'DUPLICATE' })
        } else {
          mockSendTransaction.mockResolvedValueOnce({ hash: 'close-hash', status: 'PENDING' })
          mockGetTransaction.mockResolvedValueOnce({ status: 'NOT_FOUND' })
        }

        const error = await verifyClose().catch((e: unknown) => e)
        expect(error).toBeInstanceOf(SettlementError)
        expect((error as SettlementError).message).toBe(message)
        expect(await store.get(cumulativeKey)).toEqual({
          amount: '5000000',
          signature: credential.payload.signature,
          closing: true,
        })
        await expect(verifyVoucher()).rejects.toEqual(closingError)
      },
    )

    it('does not latch the channel when the fee budget rejects a close credential', async () => {
      const signerKp = Keypair.random()
      const store = Store.memory()
      mockSimulateTransaction
        .mockResolvedValueOnce(successSimResult(Buffer.from('budget-close-bytes')))
        .mockResolvedValueOnce(successSimResult(Buffer.from('budget-voucher-bytes')))
      const method = channel({
        channel: CHANNEL_ADDRESS,
        checkOnChainState: false,
        commitmentKey: COMMITMENT_KEY,
        feePayer: { envelopeSigner: signerKp },
        maxFeeBumpStroops: 5_000_000,
        // Smaller than one settlement charge: every close is over budget.
        feeBudget: { maxStroops: 1_000_000, windowMs: 60_000 },
        store,
      })

      const closeCredential = makeSignedCredential({
        action: 'close',
        cumulativeAmount: 5000000n,
        challengeAmount: '5000000',
      })
      await expect(
        method.verify({
          credential: closeCredential as any,
          request: closeCredential.challenge.request,
        }),
      ).rejects.toEqual(
        new ChannelVerificationError(
          "[stellar:channel] Fee budget exceeded: this settlement would exceed the server's fee budget for the current window. Retry later.",
          {
            funderKey: signerKp.publicKey(),
            spentStroops: 0,
            charge: 5_000_000,
            budgetStroops: 1_000_000,
            windowMs: 60_000,
          },
        ),
      )
      expect(mockGetAccount).toHaveBeenCalledTimes(0)
      expect(mockSendTransaction).toHaveBeenCalledTimes(0)
      expect(await store.get(cumulativeKey)).toBeNull()

      // The channel keeps serving vouchers.
      const voucherCredential = makeSignedCredential({
        action: 'voucher',
        cumulativeAmount: 6000000n,
        challengeAmount: '1000000',
      })
      expect(
        (
          await method.verify({
            credential: voucherCredential as any,
            request: voucherCredential.challenge.request,
          })
        ).status,
      ).toBe('success')
      expect(await store.get(cumulativeKey)).toEqual({
        amount: '6000000',
        signature: voucherCredential.payload.signature,
      })
    })
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

    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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
      logger,
    })

    // First close settlement — should succeed, charges maxFeeBumpStroops against budget
    const credential1 = makeSignedCredential({
      action: 'close',
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
    // Also clear cumulative to allow next settlement (must be increasing)
    await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    // Also clear the challenge so we can use a new credential
    await store.delete(`stellar:channel:challenge:${credential1.challenge.id}`)

    // Second close settlement within window — should fail (budget exceeded)
    const credential2 = makeSignedCredential({
      action: 'close',
      cumulativeAmount: 2000000n,
      challengeAmount: '1000000',
    })

    await expect(
      method.verify({
        credential: credential2 as any,
        request: credential2.challenge.request,
      }),
    ).rejects.toThrow(/Fee budget exceeded/i)
    // The full budget state goes to the server log, not to the client-facing message.
    expect(logger.warn).toHaveBeenCalledWith(
      `[stellar:channel] Fee budget exceeded for funder ${signerKp.publicKey()}: spent ${maxFeeBumpStroops} stroops + charge ${maxFeeBumpStroops} stroops exceeds budget ${maxFeeBumpStroops} stroops within ${windowMs} ms window.`,
      {
        funderKey: signerKp.publicKey(),
        spentStroops: maxFeeBumpStroops,
        charge: maxFeeBumpStroops,
        budgetStroops: maxFeeBumpStroops,
        windowMs,
      },
    )

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
      await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
      await store.delete(`stellar:channel:challenge:${credential.challenge.id}`)
    }

    expect(mockSendTransaction.mock.calls.length).toBe(allowedSettlements)

    // The next settlement exceeds the cap and must be rejected before broadcast.
    const overBudget = makeSignedCredential({
      action: 'close',
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
    // Also clear cumulative to allow next settlement (must be increasing)
    await store.delete(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)
    // Also clear the challenge
    await store.delete(`stellar:channel:challenge:${credential1.challenge.id}`)

    // Second close — no budget so should succeed
    const credential2 = makeSignedCredential({
      action: 'close',
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
    const signature = COMMITMENT_KEY.sign(
      buildCommitmentMessage({
        channel: CHANNEL_ADDRESS,
        amount: BigInt(amount),
        network: STELLAR_TESTNET,
      }),
    ).toString('hex')

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
    const signature = COMMITMENT_KEY.sign(
      buildCommitmentMessage({
        channel: CHANNEL_ADDRESS,
        amount: BigInt(amount),
        network: STELLAR_TESTNET,
      }),
    ).toString('hex')

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

describe('channel server recipient pinning (on-chain payout address validation)', () => {
  const configuredRecipient = Keypair.random().publicKey()
  const unexpectedRecipient = Keypair.random().publicKey()

  beforeEach(() => {
    mockGetChannelState.mockReset()
    mockSimulateTransaction.mockReset()
  })

  function mockChannelStateWithRecipient(to: string) {
    return {
      balance: 1000000n,
      withdrawn: 0n,
      deposited: 1000000n,
      refundWaitingPeriod: 1000,
      token: 'CTOKEN...',
      from: 'GFROM...',
      to,
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    }
  }

  it('rejects a voucher when the on-chain payout address does not match the configured recipient', async () => {
    mockGetChannelState.mockResolvedValueOnce(mockChannelStateWithRecipient(unexpectedRecipient))
    const commitmentBytes = Buffer.from('recipient-pin-mismatch')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      recipient: configuredRecipient,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: credential as any, request: credential.challenge.request }),
    ).rejects.toThrow('Channel payout address does not match the configured recipient.')
  })

  it('accepts a voucher when the on-chain payout address matches the configured recipient', async () => {
    mockGetChannelState.mockResolvedValueOnce(mockChannelStateWithRecipient(configuredRecipient))
    const commitmentBytes = Buffer.from('recipient-pin-match')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      recipient: configuredRecipient,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('warns at construction when no recipient is configured while on-chain checks are enabled', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('recipient'))
  })
})

describe('channel server currency pinning (on-chain token validation)', () => {
  const configuredCurrency = 'CTOKENEXPECTEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const unexpectedToken = 'CTOKENATTACKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  beforeEach(() => {
    mockGetChannelState.mockReset()
    mockSimulateTransaction.mockReset()
  })

  function mockChannelStateWithToken(token: string) {
    return {
      balance: 1000000n,
      withdrawn: 0n,
      deposited: 1000000n,
      refundWaitingPeriod: 1000,
      token,
      from: 'GFROM...',
      to: 'GTO...',
      closeEffectiveAtLedger: null,
      currentLedger: 4000,
    }
  }

  it('rejects a voucher when the on-chain token does not match the configured currency', async () => {
    mockGetChannelState.mockResolvedValueOnce(mockChannelStateWithToken(unexpectedToken))
    const commitmentBytes = Buffer.from('currency-pin-mismatch')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      currency: configuredCurrency,
      store: Store.memory(),
    })

    await expect(
      method.verify({ credential: credential as any, request: credential.challenge.request }),
    ).rejects.toThrow('Channel token does not match the configured currency.')
  })

  it('accepts a voucher when the on-chain token matches the configured currency', async () => {
    mockGetChannelState.mockResolvedValueOnce(mockChannelStateWithToken(configuredCurrency))
    const commitmentBytes = Buffer.from('currency-pin-match')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const credential = makeSignedCredential({
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })

    const method = channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      currency: configuredCurrency,
      store: Store.memory(),
    })

    const receipt = await method.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    expect(receipt.status).toBe('success')
  })

  it('warns at construction when no currency is configured while on-chain checks are enabled', () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    channel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
      logger,
    })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('currency'))
  })
})

describe('channel server close transaction inspection (auth-tree injection)', () => {
  // A contract-supplied auth entry whose root `close` invocation carries an
  // injected `transfer` sub-invocation — the shape a malicious channel contract
  // would use to ride the envelope signature and drain the signer's account.
  const injectedTokenContract = Address.contract(Buffer.alloc(32, 7)).toString()

  function injectedTransferAuthEntry(): xdr.SorobanAuthorizationEntry {
    const transferArgs = new xdr.InvokeContractArgs({
      contractAddress: new Address(injectedTokenContract).toScAddress(),
      functionName: 'transfer',
      args: [],
    })
    const subInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transferArgs),
      subInvocations: [],
    })
    const closeArgs = new xdr.InvokeContractArgs({
      contractAddress: new Address(CHANNEL_ADDRESS).toScAddress(),
      functionName: 'close',
      args: [],
    })
    const rootInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(closeArgs),
      subInvocations: [subInvocation],
    })
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation,
    })
  }

  /** Returns the prepared close tx with an injected sub-invocation auth entry. */
  function preparedCloseWithInjectedAuth(tx: Transaction): Transaction {
    const envelope = tx.toEnvelope()
    envelope
      .v1()
      .tx()
      .operations()[0]
      .body()
      .invokeHostFunctionOp()
      .auth([injectedTransferAuthEntry()])
    return new Transaction(envelope, Networks.TESTNET)
  }

  beforeEach(() => {
    mockGetAccount.mockReset()
    mockSimulateTransaction.mockReset()
    mockSendTransaction.mockReset()
    mockPrepareTransaction.mockReset()
  })

  it('rejects a verified close whose prepared auth tree carries injected sub-invocations', async () => {
    const signerKp = Keypair.random()
    const commitmentBytes = Buffer.from('close-auth-inject')
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '70'))
    mockPrepareTransaction.mockImplementationOnce((tx: Transaction) =>
      preparedCloseWithInjectedAuth(tx),
    )

    const credential = makeSignedCredential({
      action: 'close',
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
      method.verify({ credential: credential as any, request: credential.challenge.request }),
    ).rejects.toThrow('Prepared close authorization carries unexpected sub-invocations.')
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('rejects the operator close() when the prepared auth tree carries injected sub-invocations', async () => {
    const { close } = await import('./Channel.js')
    const signerKp = Keypair.random()
    mockGetAccount.mockResolvedValueOnce(new Account(signerKp.publicKey(), '71'))
    mockPrepareTransaction.mockImplementationOnce((tx: Transaction) =>
      preparedCloseWithInjectedAuth(tx),
    )

    await expect(
      close({
        channel: CHANNEL_ADDRESS,
        amount: 5000000n,
        signature: Buffer.alloc(64, 1),
        feePayer: { envelopeSigner: signerKp },
      }),
    ).rejects.toThrow('Prepared close authorization carries unexpected sub-invocations.')
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// RPC-outside-the-lock tests
// ---------------------------------------------------------------------------

describe('channel verification runs RPC outside the cumulative lock', () => {
  // The server verifies commitment signatures against a message that it builds
  // locally. The on-chain state read is therefore the only RPC call that stays
  // in the verification path.
  const COMMITMENT_BYTES = Buffer.from('unlocked-rpc-commitment-bytes')

  // These tests swap in delayed mock implementations. Mocks are not auto-cleared
  // in this file, so restore the module-level defaults rather than leaving a
  // slow getChannelState behind for whatever test is added next.
  afterEach(() => {
    mockGetChannelState.mockReset()
    mockGetChannelState.mockResolvedValue(mockHealthyChannelState())
  })

  /**
   * Replaces the on-chain state mock with a slow one that records how many
   * state reads are in flight at once.
   *
   * `verifyOnChainState` is a separate, multi-call RPC path from the
   * signature simulation, so it needs its own overlap assertion — tests that
   * run with `checkOnChainState: false` would still pass if this path alone
   * were moved back under the cumulative lock.
   *
   * @returns A live counter — read `max` after the verifies settle.
   */
  function trackStateReadConcurrency(delayMs = 50) {
    const counter = { inFlight: 0, max: 0 }
    mockGetChannelState.mockReset()
    mockGetChannelState.mockImplementation(() => {
      counter.inFlight++
      counter.max = Math.max(counter.max, counter.inFlight)
      return new Promise((resolve) =>
        setTimeout(() => {
          counter.inFlight--
          resolve(mockHealthyChannelState())
        }, delayMs),
      )
    })
    return counter
  }

  /** Credentials all signed over the same bytes, so each passes the mocked
   *  `prepare_commitment` signature check regardless of its amount. */
  function makeConcurrentCredentials(amounts: bigint[]) {
    return amounts.map((amount) =>
      makeSignedCredential({
        cumulativeAmount: amount,
        challengeAmount: amount.toString(),
      }),
    )
  }

  it('overlaps on-chain state reads across concurrent verifies', async () => {
    // Same guarantee as above, for the other RPC path. `verifyOnChainState`
    // costs several calls, so serializing it under the lock would stall
    // concurrent payers just as badly — and the checkOnChainState: false tests
    // above cannot detect that.
    const stateReads = trackStateReadConcurrency()

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: true,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    const credentials = makeConcurrentCredentials([1000n, 2000n, 3000n, 4000n])
    await Promise.allSettled(
      credentials.map((c) => method.verify({ credential: c as any, request: c.challenge.request })),
    )

    // All four reach the state read together: one verification progresses into
    // it while the others' reads are still pending.
    expect(stateReads.max).toBe(4)
  })

  it('bounds concurrent on-chain state reads by verifyMaxConcurrent', async () => {
    // The semaphore wraps both RPC paths, so it caps state reads too.
    const stateReads = trackStateReadConcurrency()

    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: true,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
      verifyMaxConcurrent: 2,
    })

    const credentials = makeConcurrentCredentials([1000n, 2000n, 3000n, 4000n])
    await Promise.allSettled(
      credentials.map((c) => method.verify({ credential: c as any, request: c.challenge.request })),
    )

    expect(stateReads.max).toBe(2)
  })

  it('still admits exactly one of several concurrent credentials at the same cumulative', async () => {
    // Unlocked RPC must not weaken monotonicity: all four clear the pre-RPC
    // short-circuit against a cumulative of 0, then serialize in the locked
    // commit, where only the first can advance the cumulative.
    const method = channel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: Store.memory(),
    })

    const credentials = makeConcurrentCredentials([1000n, 1000n, 1000n, 1000n])
    const results = await Promise.allSettled(
      credentials.map((c) => method.verify({ credential: c as any, request: c.challenge.request })),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const rejected of results.filter((r) => r.status === 'rejected')) {
      expect((rejected as PromiseRejectedResult).reason.message).toContain(
        'must be greater than previous cumulative',
      )
    }
  })
})
