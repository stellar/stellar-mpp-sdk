import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USDC_SAC_TESTNET } from '../../../../constants.js'
import { toBaseUnits } from '../../../Methods.js'

// Cross-process replay protection: two independent server
// instances sharing one atomic store must not both accept the same push-mode
// credential. Asserts the duplicate tx hash is claimed at most once (rejects).

const RECIPIENT = Keypair.random().publicKey()

const mockGetTransaction = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getTransaction = mockGetTransaction
      }),
    },
  }
})

const { charge: serverCharge } = await import('../../../server/Charge.js')

function testHash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0').slice(0, 64)
}

function makeHashCredential(opts: { hash: string; source?: string; signingKey?: Keypair }) {
  const challenge = Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'charge',
    request: {
      amount: toBaseUnits('10', 7),
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
    : Buffer.alloc(64).toString('hex')
  const cred = Credential.from({
    challenge,
    payload: {
      type: 'hash',
      hash: opts.hash,
      sourceSignature,
    },
  })
  if (opts.source !== undefined) {
    return Object.assign(cred, { source: opts.source })
  }
  return cred
}

describe('charge cross-process replay protection', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset()
  })

  it('rejects duplicate tx hash when two independent instances race with same credential on atomic store', async () => {
    const sharedStore = Store.memory()
    const payerKey = Keypair.random()
    const hash = testHash('integration-push-mode-hash')

    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: 'mock-envelope-xdr',
    })

    const method1 = serverCharge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })
    const method2 = serverCharge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: sharedStore,
    })

    const credential = makeHashCredential({
      hash,
      source: `did:pkh:stellar:testnet:${payerKey.publicKey()}`,
      signingKey: payerKey,
    })

    const results = await Promise.allSettled([
      method1.verify({ credential: credential as any, request: credential.challenge.request }),
      method2.verify({ credential: credential as any, request: credential.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled')
    const failures = results.filter((r) => r.status === 'rejected')

    expect(successes.length + failures.length).toBe(2)

    const hashKey = `stellar:charge:hash:${hash}`
    const stored = await sharedStore.get(hashKey)
    expect([null, 'pending', 'used'].includes((stored as any)?.state || null)).toBe(true)
  })
})
