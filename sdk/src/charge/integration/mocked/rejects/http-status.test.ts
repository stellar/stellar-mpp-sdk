import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { Challenge, Credential, Method, Store } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { USDC_SAC_TESTNET } from '../../../../constants.js'
import { SettlementError } from '../../../../shared/errors.js'
import { charge as chargeMethod } from '../../../Methods.js'
import { charge as serverCharge } from '../../../server/Charge.js'

// Drives rejected credentials through the real (unmocked) mppx server handler
// and asserts the HTTP response a client receives. Every case is rejected
// before any RPC call, so no network access is needed.

const URL = 'http://localhost/resource'
const SECRET_KEY = 'http-status-test-secret-key-min-32-bytes'
const PAYER = Keypair.random()
const RECIPIENT = Keypair.random().publicKey()
const SOURCE = `did:pkh:stellar:testnet:${PAYER.publicKey()}`

type Handler = (request: Request) => Promise<{ status: number; challenge?: Response }>

/** Fetches a challenge, answers it with `payload`, and returns the server's response. */
async function respondWith(handler: Handler, payload: Record<string, unknown>): Promise<Response> {
  const first = await handler(new Request(URL))
  expect(first.status).toBe(402)
  const challenge = Challenge.fromResponse(first.challenge!)
  const authorization = Credential.serialize({ challenge, payload, source: SOURCE } as never)
  const second = await handler(new Request(URL, { headers: { Authorization: authorization } }))
  expect(second.status).toBe(402)
  return second.challenge!
}

function chargeHandler(): Handler {
  const mppx = Mppx.create({
    secretKey: SECRET_KEY,
    methods: [
      serverCharge({ recipient: RECIPIENT, currency: USDC_SAC_TESTNET, store: Store.memory() }),
    ],
  })
  return mppx.charge({ amount: '1' })
}

describe('charge rejection HTTP status (real mppx handler)', () => {
  it('answers a rejected credential with 402, a fresh challenge, and the rejection reason', async () => {
    const response = await respondWith(chargeHandler(), {
      type: 'hash',
      hash: 'a'.repeat(64),
    })

    expect(response.status).toBe(402)
    expect(response.headers.get('Content-Type')).toBe('application/problem+json')
    const retry = Challenge.fromResponse(response)
    expect(retry.method).toBe('stellar')
    expect(retry.intent).toBe('charge')
    expect(await response.json()).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail:
        '[stellar:charge] Unsigned push mode (type="hash") is no longer accepted. Upgrade your client to send type="signedHash", or use server-sponsored flow.',
      challengeId: retry.id,
    })
  })

  it('omits error details from the client-facing problem', async () => {
    // Transfers 1 stroop instead of the requested 1 unit (10^7 stroops). The
    // rejection carries details `{ expected, actual }`, which must stay server-side.
    const tx = new TransactionBuilder(new Account(PAYER.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract(USDC_SAC_TESTNET).call(
          'transfer',
          new Address(PAYER.publicKey()).toScVal(),
          new Address(RECIPIENT).toScVal(),
          nativeToScVal(1n, { type: 'i128' }),
        ),
      )
      .setTimeout(180)
      .build()
    tx.sign(PAYER)

    const response = await respondWith(chargeHandler(), {
      type: 'transaction',
      transaction: tx.toXDR(),
    })

    expect(response.status).toBe(402)
    const body = await response.json()
    expect(body).toEqual({
      type: 'https://paymentauth.org/problems/verification-failed',
      title: 'Verification Failed',
      status: 402,
      detail: '[stellar:charge] Transfer amount does not match expected amount.',
      challengeId: Challenge.fromResponse(response).id,
    })
  })

  it('answers a SettlementError with a generic 500 that exposes no settlement details', async () => {
    const mppx = Mppx.create({
      secretKey: SECRET_KEY,
      methods: [
        Method.toServer(chargeMethod, {
          defaults: { currency: USDC_SAC_TESTNET, recipient: RECIPIENT },
          async verify() {
            throw new SettlementError('[stellar:charge] Settlement failed: RPC unreachable.', {
              details: 'connect ECONNREFUSED https://rpc.internal.example',
            })
          },
        }),
      ],
    })

    const response = await respondWith(mppx.charge({ amount: '1' }), {
      type: 'hash',
      hash: 'a'.repeat(64),
    })

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
