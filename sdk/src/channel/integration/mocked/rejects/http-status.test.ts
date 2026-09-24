import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, it } from 'vitest'
import { channel as serverChannel } from '../../../server/Channel.js'

// Drives a rejected channel credential through the real (unmocked) mppx server
// handler and asserts the HTTP response a client receives. The credential is
// rejected before any RPC call, so no network access is needed.

const URL = 'http://localhost/resource'
const SECRET_KEY = 'http-status-test-secret-key-min-32-bytes'
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

describe('channel rejection HTTP status (real mppx handler)', () => {
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
})
