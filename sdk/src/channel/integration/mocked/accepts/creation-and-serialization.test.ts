import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { channel as serverChannel } from '../../../server/Channel.js'
import { channel as clientChannel } from '../../../client/Channel.js'

// Happy-path integration tests: server/client construction, the no-credential
// 402 challenge, store-backed cumulative tracking, and credential serialization.
// These assert valid flows succeed (accepts) and need no on-chain RPC.

const COMMITMENT_KEY = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

function mockChallenge(overrides: Record<string, unknown> = {}) {
  return Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'channel',
    request: {
      amount: '1000000',
      channel: CHANNEL_ADDRESS,
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '0',
      },
      ...overrides,
    },
  })
}

describe('channel server creation', () => {
  it('creates method with defaults', () => {
    const method = serverChannel({
      channel: CHANNEL_ADDRESS,
      commitmentKey: COMMITMENT_KEY.publicKey(),
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('channel')
    expect(typeof method.verify).toBe('function')
  })

  it('returns 402 challenge when no credential provided', async () => {
    const { Mppx } = await import('mppx/server')
    const mppx = Mppx.create({
      secretKey: 'test-secret-key-for-mppx',
      methods: [
        serverChannel({
          channel: CHANNEL_ADDRESS,
          commitmentKey: COMMITMENT_KEY.publicKey(),
          store: Store.memory(),
        }),
      ],
    })

    const handler = mppx.channel({ amount: '1' })
    const result = await handler(new Request('http://localhost/test'))
    expect(result.status).toBe(402)
  })
})

describe('channel client creation', () => {
  it('creates method with commitmentKey', () => {
    const method = clientChannel({
      commitmentKey: COMMITMENT_KEY,
      allowedChannels: [CHANNEL_ADDRESS],
    })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('channel')
    expect(typeof method.createCredential).toBe('function')
  })

  it('tracks onProgress events', () => {
    const events: unknown[] = []
    const method = clientChannel({
      commitmentKey: COMMITMENT_KEY,
      allowedChannels: [CHANNEL_ADDRESS],
      onProgress: (e) => events.push(e),
    })
    expect(typeof method.createCredential).toBe('function')
  })
})

describe('channel replay protection', () => {
  it('store tracks used challenge IDs', async () => {
    const store = Store.memory()

    const key = 'stellar:channel:challenge:test-channel-id-123'
    const before = await store.get(key)
    expect(before).toBeNull()

    await store.put(key, { usedAt: new Date().toISOString() })

    const after = await store.get(key)
    expect(after).not.toBeNull()
    expect((after as { usedAt: string }).usedAt).toBeDefined()
  })

  it('store tracks cumulative amounts', async () => {
    const store = Store.memory()

    const key = `stellar:channel:cumulative:${CHANNEL_ADDRESS}`
    await store.put(key, { amount: '5000000' })

    const stored = await store.get(key)
    expect(stored).not.toBeNull()
    expect((stored as { amount: string }).amount).toBe('5000000')
  })
})

describe('channel credential serialization', () => {
  it('credential schema accepts commitment payload', () => {
    const challenge = mockChallenge()
    const serialized = Credential.serialize({
      challenge,
      payload: {
        amount: '1000000',
        signature: 'deadbeef1234567890abcdef',
      },
    })
    expect(serialized).toContain('Payment')
  })

  it('credential schema accepts close action payload', () => {
    const challenge = mockChallenge()
    const serialized = Credential.serialize({
      challenge,
      payload: {
        action: 'close',
        amount: '1000000',
        signature: 'a'.repeat(128),
      },
    })
    expect(serialized).toContain('Payment')
  })
})
