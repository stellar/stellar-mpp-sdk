import { Keypair } from '@stellar/stellar-sdk'
import { Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'

// Runs the real mppx client retry loop against the real channel server. When
// the server does not accept a voucher, it sends a new 402 challenge. The
// retry signs the same payment amount.

const COMMITMENT_KEY = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
const PAYMENT_STROOPS = '200000000' // 20 XLM

const { channel: serverChannel } = await import('../../../server/Channel.js')
const { channel: clientChannel } = await import('../../../client/Channel.js')

/**
 * Returns a client store that delays the write of `delayedAmount`, so that
 * its signature completes after the others.
 */
function delayedWrites(store: Store.AtomicStore, delayedAmount?: bigint): Store.AtomicStore {
  return {
    get: (key) => store.get(key),
    put: (key, value) => store.put(key, value),
    delete: (key) => store.delete(key),
    update: async (key, fn) => {
      const change = fn(await store.get(key))
      const amount = change.op === 'set' ? (change.value as { amount: string }).amount : undefined
      if (amount === delayedAmount?.toString()) await new Promise((r) => setTimeout(r, 20))
      return store.update(key, fn)
    },
  }
}

type Credentials = ReturnType<typeof Credential.deserialize>[]

/**
 * Connects a real mppx client to a real channel server. `alter` can change the
 * credential of each paid request before the server gets it.
 */
async function setup(
  alter: (credential: string, paidRequest: number) => string | undefined,
  delayedAmount?: bigint,
) {
  const { Mppx } = await import('mppx/server')
  const { Mppx: MppxClient } = await import('mppx/client')

  const serverStore = Store.memory()
  const server = Mppx.create({
    secretKey: 'test-secret-key-for-mppx-min-32-bytes',
    methods: [
      serverChannel({
        channel: CHANNEL_ADDRESS,
        commitmentKey: COMMITMENT_KEY.publicKey(),
        store: serverStore,
        checkOnChainState: false,
        network: 'stellar:testnet',
      }),
    ],
  })
  // Each path is a resource with its own price in XLM.
  const handlers = {
    '/resource': server.channel({ amount: '20' }),
    '/large': server.channel({ amount: '60' }),
  }

  const sent: Credentials = []
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const credential = headers.get('authorization')
    if (credential) {
      sent.push(Credential.deserialize(credential))
      const altered = alter(credential, sent.length)
      if (altered === undefined) headers.delete('authorization')
      else headers.set('authorization', altered)
    }
    const handler = handlers[new URL(url).pathname as keyof typeof handlers]
    const result = await handler(new Request(url, { headers }))
    if (result.status === 402) return result.challenge as Response
    return result.withReceipt(Response.json({ ok: true })) as Response
  }) as typeof fetch

  const clientStore = delayedWrites(Store.memory(), delayedAmount)
  const client = MppxClient.create({
    fetch: transport,
    polyfill: false,
    methods: [
      clientChannel({
        commitmentKey: COMMITMENT_KEY,
        allowedChannels: [CHANNEL_ADDRESS],
        store: clientStore,
        network: 'stellar:testnet',
      }),
    ],
  })

  const cumulative = async (store: Store.Store, key: string) =>
    ((await store.get(key)) as { amount: string }).amount
  return {
    client,
    sent,
    serverCumulative: () =>
      cumulative(serverStore, `stellar:channel:cumulative:${CHANNEL_ADDRESS}`),
    clientCumulative: () =>
      cumulative(
        clientStore,
        `stellar:channel:client:stellar:testnet:${CHANNEL_ADDRESS}:cumulative`,
      ),
  }
}

const sentAmounts = (sent: Credentials) =>
  sent.map((credential) => (credential.payload as { amount: string }).amount)

describe('channel voucher retry', () => {
  it('signs one payment amount when the first voucher does not reach the server', async () => {
    const { client, sent, serverCumulative, clientCumulative } = await setup(
      (credential, paidRequest) => (paidRequest === 1 ? undefined : credential),
    )

    const response = await client.fetch('http://localhost/resource')

    expect(response.status).toBe(200)
    expect(sentAmounts(sent)).toEqual([PAYMENT_STROOPS, PAYMENT_STROOPS])
    expect(await serverCumulative()).toBe(PAYMENT_STROOPS)
    expect(await clientCumulative()).toBe(PAYMENT_STROOPS)
  })

  it('signs one payment amount when the server does not accept the first voucher', async () => {
    // Change the first signature so that the server verification fails.
    const { client, sent, serverCumulative, clientCumulative } = await setup(
      (credential, paidRequest) => {
        if (paidRequest !== 1) return credential
        const decoded = Credential.deserialize(credential)
        const payload = decoded.payload as { signature: string }
        const signature = (payload.signature[0] === '0' ? '1' : '0') + payload.signature.slice(1)
        return Credential.serialize({ ...decoded, payload: { ...payload, signature } } as any)
      },
    )

    const response = await client.fetch('http://localhost/resource')

    expect(response.status).toBe(200)
    expect(sentAmounts(sent)).toEqual([PAYMENT_STROOPS, PAYMENT_STROOPS])
    expect(await serverCumulative()).toBe(PAYMENT_STROOPS)
    expect(await clientCumulative()).toBe(PAYMENT_STROOPS)
  })

  it('completes two payments that run at the same time with the exact total', async () => {
    // The 20 XLM signature completes last, so it is the last local write.
    const { client, sent, serverCumulative, clientCumulative } = await setup(
      (credential) => credential,
      BigInt(PAYMENT_STROOPS),
    )

    const responses = await Promise.all([
      client.fetch('http://localhost/large'),
      client.fetch('http://localhost/resource'),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    // The 20 XLM payment retries from the cumulative that the server accepted.
    const twoPayments = '800000000' // 60 XLM + 20 XLM
    expect(sentAmounts(sent)).toEqual(['600000000', PAYMENT_STROOPS, twoPayments])
    expect(await serverCumulative()).toBe(twoPayments)
    expect(await clientCumulative()).toBe(twoPayments)
  })
})
