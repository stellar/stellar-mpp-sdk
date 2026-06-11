import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Cross-process replay protection: two independent server
// instances sharing one atomic store must not both accept the same credential.
// Asserts the second concurrent attempt is rejected (rejects).

const COMMITMENT_KEY = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

const mockSimulateTransaction = vi.fn()

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
      }),
    },
  }
})

const { channel: serverChannel } = await import('../../../server/Channel.js')

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

function successSimResult(commitmentBytes: Buffer) {
  return { result: { retval: { bytes: () => commitmentBytes } }, transactionData: 'mock' }
}

describe('channel cross-process replay protection', () => {
  beforeEach(() => {
    mockSimulateTransaction.mockReset()
  })

  it('rejects duplicate voucher when two independent instances race with same credential on atomic store', async () => {
    const sharedStore = Store.memory()
    const commitmentBytes = Buffer.from('integration-race-bytes')

    mockSimulateTransaction.mockResolvedValue(successSimResult(commitmentBytes))

    const method1 = serverChannel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })
    const method2 = serverChannel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })

    const credential = makeSignedCredential({
      commitmentBytes,
      cumulativeAmount: 5000000n,
      challengeAmount: '5000000',
    })

    const promise1 = method1.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    const promise2 = method2.verify({
      credential: credential as any,
      request: credential.challenge.request,
    })
    const results = await Promise.allSettled([promise1, promise2])

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    const failureReason = (failures[0] as PromiseRejectedResult).reason
    expect(failureReason?.message).toContain('Replay rejected')

    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    const stored = (await sharedStore.get(cumulativeKey)) as { amount: string }
    expect(stored.amount).toBe('5000000')

    const challengeKey = `stellar:channel:challenge:${credential.challenge.id}`
    const challengeRecord = await sharedStore.get(challengeKey)
    expect(challengeRecord).toBeDefined()
    expect((challengeRecord as any).state).toBe('used')
  })

  it('enforces atomic monotonic check: two concurrent vouchers with different cumulative amounts', async () => {
    const sharedStore = Store.memory()
    const commitmentBytes1 = Buffer.from('monotonic-race-bytes-1')
    const commitmentBytes2 = Buffer.from('monotonic-race-bytes-2')

    mockSimulateTransaction
      .mockResolvedValueOnce(successSimResult(commitmentBytes1))
      .mockResolvedValueOnce(successSimResult(commitmentBytes2))

    const method1 = serverChannel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })
    const method2 = serverChannel({
      channel: CHANNEL_ADDRESS,
      checkOnChainState: false,
      commitmentKey: COMMITMENT_KEY,
      store: sharedStore,
    })

    const credential1 = makeSignedCredential({
      commitmentBytes: commitmentBytes1,
      cumulativeAmount: 1000000n,
      challengeAmount: '1000000',
    })
    const credential2 = makeSignedCredential({
      commitmentBytes: commitmentBytes2,
      cumulativeAmount: 2000000n,
      challengeAmount: '1000000',
    })

    const results = await Promise.allSettled([
      method1.verify({ credential: credential1 as any, request: credential1.challenge.request }),
      method2.verify({ credential: credential2 as any, request: credential2.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')

    expect(successes.length >= 1).toBe(true)

    const cumulativeKey = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    const stored = (await sharedStore.get(cumulativeKey)) as { amount: string }
    expect(['1000000', '2000000']).toContain(stored.amount)
  })
})
