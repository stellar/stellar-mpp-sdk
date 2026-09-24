import { Account, Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { Mppx } from 'mppx/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Drives channel credentials through the real (unmocked) mppx server handler
// and asserts the HTTP response a client receives. Only the Soroban RPC client
// is stubbed, so no network access is needed.

const URL = 'http://localhost/resource'
const SECRET_KEY = 'http-status-test-secret-key-min-32-bytes'
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

const mockSimulateTransaction = vi.fn()
const mockGetAccount = vi.fn()
const mockPrepareTransaction = vi.fn()
const mockSendTransaction = vi.fn()
const mockGetTransaction = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.simulateTransaction = mockSimulateTransaction
        this.getAccount = mockGetAccount
        this.prepareTransaction = mockPrepareTransaction
        this.sendTransaction = mockSendTransaction
        this.getTransaction = mockGetTransaction
      }),
    },
  }
})

const { channel: serverChannel } = await import('../../../server/Channel.js')

describe('channel rejection HTTP status (real mppx handler)', () => {
  beforeEach(() => {
    for (const mock of [
      mockSimulateTransaction,
      mockGetAccount,
      mockPrepareTransaction,
      mockSendTransaction,
      mockGetTransaction,
    ])
      mock.mockReset()
  })

  it('answers a rejected credential with 402, a fresh challenge, and no error details', async () => {
    const mppx = Mppx.create({
      secretKey: SECRET_KEY,
      methods: [
        serverChannel({
          channel: CHANNEL_ADDRESS,
          commitmentKey: Keypair.random(),
          store: Store.memory(),
        }),
      ],
    })
    const handler = mppx.channel({ amount: '1' })

    const first = await handler(new Request(URL))
    expect(first.status).toBe(402)
    const challenge = Challenge.fromResponse(first.challenge)
    // A commitment of 1 stroop cannot cover the requested 1 unit (10^7 stroops).
    // The rejection carries amount details that must stay server-side.
    const authorization = Credential.serialize({
      challenge,
      payload: { action: 'voucher', amount: '1', signature: 'ab'.repeat(64) },
    })
    const second = await handler(new Request(URL, { headers: { Authorization: authorization } }))
    expect(second.status).toBe(402)
    const response = second.challenge

    expect(response.status).toBe(402)
    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const retry = Challenge.fromResponse(response)
    expect(retry.method).toBe('stellar')
    expect(retry.intent).toBe('channel')
    expect(await response.json()).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail:
        '[stellar:channel] Commitment amount 1 does not cover the requested amount 10000000 (previous cumulative: 0).',
      challengeId: retry.id,
    })
  })
  it('answers a close whose settlement fails with a generic 500 that exposes no settlement details', async () => {
    const commitmentKey = Keypair.random()
    const envelopeSigner = Keypair.random()
    const commitmentBytes = Buffer.from('close-commitment-bytes')
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: { bytes: () => commitmentBytes } },
      transactionData: 'mock',
    })
    mockGetAccount.mockResolvedValue(new Account(envelopeSigner.publicKey(), '100'))
    mockPrepareTransaction.mockImplementation((tx: unknown) => tx)
    mockSendTransaction.mockResolvedValue({ hash: 'close-hash', status: 'PENDING' })
    mockGetTransaction.mockResolvedValue({ status: 'FAILED', resultXdr: 'close-result-xdr' })

    const mppx = Mppx.create({
      secretKey: SECRET_KEY,
      methods: [
        serverChannel({
          channel: CHANNEL_ADDRESS,
          checkOnChainState: false,
          commitmentKey: commitmentKey.publicKey(),
          feePayer: { envelopeSigner },
          store: Store.memory(),
        }),
      ],
    })
    const handler = mppx.channel({ amount: '1' })

    const first = await handler(new Request(URL))
    expect(first.status).toBe(402)
    const challenge = Challenge.fromResponse(first.challenge)
    const authorization = Credential.serialize({
      challenge,
      payload: {
        action: 'close',
        amount: '10000000',
        signature: Buffer.from(commitmentKey.sign(commitmentBytes)).toString('hex'),
      },
    })
    const second = await handler(new Request(URL, { headers: { Authorization: authorization } }))
    const response = second.challenge

    expect(mockGetTransaction).toHaveBeenCalledWith('close-hash')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      type: 'https://paymentauth.org/problems/internal-payment-error',
      title: 'Internal Payment Error',
      status: 500,
      detail: 'An internal payment error occurred.',
      challengeId: Challenge.fromHeaders(response.headers).id,
    })
  })
})
