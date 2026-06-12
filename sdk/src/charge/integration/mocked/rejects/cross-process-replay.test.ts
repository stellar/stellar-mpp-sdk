import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { USDC_SAC_TESTNET } from '../../../../constants.js'
import { toBaseUnits } from '../../../Methods.js'

// Cross-process replay protection: two independent server instances sharing one
// atomic store must not both accept the same confirmed tx hash. The two requests
// carry distinct challenges but the same hash, so they race on the shared hash
// claim — exactly one is accepted, the other is rejected.

const RECIPIENT = Keypair.random().publicKey()
const PAYER = Keypair.random()
const AMOUNT = toBaseUnits('10', 7)

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

function buildTransferTxXdr(): string {
  const account = new Account(PAYER.publicKey(), '0')
  const contract = new Contract(USDC_SAC_TESTNET)
  const transferOp = contract.call(
    'transfer',
    new Address(PAYER.publicKey()).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(BigInt(AMOUNT), { type: 'i128' }),
  )
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
  tx.sign(PAYER)
  return tx.toXDR()
}

function makeSignedHashCredential(hash: string) {
  const challenge = Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'charge',
    request: {
      amount: AMOUNT,
      currency: USDC_SAC_TESTNET,
      recipient: RECIPIENT,
      methodDetails: {
        network: 'stellar:testnet',
      },
    },
  })
  const canonicalHash = hash.toLowerCase()
  const bindingMessage = Buffer.from(`${challenge.id}:${canonicalHash}`)
  const sourceSignature = Buffer.from(PAYER.sign(bindingMessage)).toString('hex')
  return Object.assign(
    Credential.from({
      challenge,
      payload: {
        type: 'signedHash',
        hash,
        sourceSignature,
      },
    }),
    { source: `did:pkh:stellar:testnet:${PAYER.publicKey()}` },
  )
}

describe('charge cross-process replay protection', () => {
  beforeEach(() => {
    mockGetTransaction.mockReset()
  })

  it('rejects the duplicate tx hash when two independent instances race the same hash on a shared atomic store', async () => {
    const sharedStore = Store.memory()
    const hash = testHash('integration-push-mode-hash')

    mockGetTransaction.mockResolvedValue({
      status: 'SUCCESS',
      envelopeXdr: buildTransferTxXdr(),
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

    const credential1 = makeSignedHashCredential(hash)
    const credential2 = makeSignedHashCredential(hash)

    const results = await Promise.allSettled([
      method1.verify({ credential: credential1 as any, request: credential1.challenge.request }),
      method2.verify({ credential: credential2 as any, request: credential2.challenge.request }),
    ])

    const successes = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
      status: string
      reference: string
    }>[]
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    expect(successes[0].value.status).toBe('success')
    expect(successes[0].value.reference).toBe(hash.toLowerCase())
    expect(failures[0].reason?.message).toContain('Replay rejected')

    const stored = (await sharedStore.get(`stellar:charge:hash:${hash}`)) as {
      state: string
    } | null
    expect(stored?.state).toBe('used')
  })
})
