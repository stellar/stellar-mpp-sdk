import { Account, Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { STELLAR_TESTNET } from '../../../../constants.js'
import { buildCommitmentMessage } from '../../../commitment.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// End-to-end closing-latch rejection.
//
// Unlike the unit tests in server/Channel.test.ts (which pre-populate the
// closing latch), this test drives a REAL close credential through the public
// verify() dispatch so the latch is set by the actual close path. The close's
// broadcast then fails. Closing is final, so a subsequent higher-cumulative
// voucher — one that would otherwise pass every monotonic/coverage check — must
// be rejected because the channel is closing.

const COMMITMENT_KEY = Keypair.random()
const ENVELOPE_KEY = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

// Hoisted mock stubs for use in the vi.mock factory.
const mockSimulateTransaction = vi.fn()
const mockGetAccount = vi.fn()
const mockPrepareTransaction = vi.fn()
const mockSendTransaction = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  const OriginalTransactionBuilder = actual.TransactionBuilder
  return {
    ...actual,
    TransactionBuilder: Object.assign(
      function (...args: any[]) {
        return new (OriginalTransactionBuilder as any)(...args)
      },
      { ...OriginalTransactionBuilder },
    ),
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.simulateTransaction = mockSimulateTransaction
        this.getAccount = mockGetAccount
        this.prepareTransaction = mockPrepareTransaction
        this.sendTransaction = mockSendTransaction
      }),
    },
  }
})

// Re-import after the mock is registered.
const { channel: serverChannel } = await import('../../../server/Channel.js')

/** Build a credential with a real ed25519 signature over `commitmentBytes`. */
function makeSignedCredential(opts: {
  action: 'voucher' | 'close'
  commitmentBytes: Buffer
  cumulativeAmount: bigint
  challengeAmount: string
  previousCumulative?: string
}) {
  const sigHex = Buffer.from(
    COMMITMENT_KEY.sign(
      buildCommitmentMessage({
        channel: CHANNEL_ADDRESS,
        amount: opts.cumulativeAmount,
        network: STELLAR_TESTNET,
      }),
    ),
  ).toString('hex')
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
      action: opts.action,
      amount: opts.cumulativeAmount.toString(),
      signature: sigHex,
    },
  })
}

/** A successful prepare_commitment simulation returning the given bytes. */
function successSimResult(commitmentBytes: Buffer) {
  return { result: { retval: { bytes: () => commitmentBytes } }, transactionData: 'mock' }
}

describe('channel closing-latch rejection — end-to-end', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
    mockGetAccount.mockReset()
    mockPrepareTransaction.mockReset()
    mockSendTransaction.mockReset()
  })

  it('rejects a higher-cumulative voucher after a real close has latched the channel', async () => {
    const store = Store.memory()
    const closeBytes = Buffer.from('close-commitment-bytes')
    const voucherBytes = Buffer.from('voucher-commitment-bytes')

    // verifyCommitmentSignature simulates prepare_commitment once per credential:
    // first the close, then (only if the closing guard is bypassed) the voucher.
    mockSimulateTransaction
      .mockResolvedValueOnce(successSimResult(closeBytes))
      .mockResolvedValueOnce(successSimResult(voucherBytes))

    // Let the close reach broadcast, then fail it. The latch stays: the channel
    // must not reopen to new vouchers.
    mockGetAccount.mockResolvedValue(new Account(ENVELOPE_KEY.publicKey(), '100'))
    mockPrepareTransaction.mockImplementation((tx: any) => tx)
    mockSendTransaction.mockRejectedValue(new Error('RPC down'))

    const server = serverChannel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      feePayer: { envelopeSigner: ENVELOPE_KEY },
      store,
    })

    // 1. Drive a real close credential through verify(). Phase 1 writes the
    //    cumulative with the closing latch under the lock; phase 2 broadcast
    //    fails, so verify() rejects and the latch remains.
    const closeCredential = makeSignedCredential({
      action: 'close',
      commitmentBytes: closeBytes,
      cumulativeAmount: 5_000_000n,
      challengeAmount: '1000000',
    })
    await expect(
      server.verify({
        credential: closeCredential as any,
        request: closeCredential.challenge.request,
      }),
    ).rejects.toThrow('broadcast failed')

    // The latch must be set by the real close path, with the pair to close with.
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toEqual({
      amount: '5000000',
      signature: closeCredential.payload.signature,
      closing: true,
    })

    // 2. A higher-cumulative voucher that WOULD otherwise settle (7,000,000 >
    //    previous 5,000,000 and covers the requested amount) must be rejected
    //    because the channel is closing.
    const voucherCredential = makeSignedCredential({
      action: 'voucher',
      commitmentBytes: voucherBytes,
      cumulativeAmount: 7_000_000n,
      challengeAmount: '1000000',
      previousCumulative: '5000000',
    })
    await expect(
      server.verify({
        credential: voucherCredential as any,
        request: voucherCredential.challenge.request,
      }),
    ).rejects.toThrow('Channel is closing — no further credentials accepted.')

    // The rejected voucher must not have advanced the cumulative.
    expect(await store.get(`stellar:channel:cumulative:${CHANNEL_ADDRESS}`)).toEqual({
      amount: '5000000',
      signature: closeCredential.payload.signature,
      closing: true,
    })
  })
})
