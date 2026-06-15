import { Address, Keypair, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { Challenge, Store } from 'mppx'
import { describe, expect, it, vi } from 'vitest'

const mockGetAccount = vi.fn()
const mockSimulateTransaction = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getAccount = mockGetAccount
        this.simulateTransaction = mockSimulateTransaction
      }),
    },
  }
})

const { channel } = await import('./Channel.js')

const TEST_KEYPAIR = Keypair.random()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'

function makeMethod(overrides: Record<string, unknown> = {}) {
  return channel({
    commitmentKey: TEST_KEYPAIR,
    allowUnpinnedChannel: true,
    ...overrides,
  } as Parameters<typeof channel>[0])
}

// Default mock: getAccount returns a valid account stub
mockGetAccount.mockResolvedValue({
  accountId: () => TEST_KEYPAIR.publicKey(),
  sequenceNumber: () => '0',
  sequence: () => '0',
  incrementSequenceNumber: () => {},
})

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

/**
 * Builds commitment bytes exactly as the one-way-channel contract's
 * `prepare_commitment` does: the XDR of an `ScVal::Map` with four
 * alphabetically-sorted entries (amount, channel, domain, network). Used to
 * mock a well-formed simulation result that the client's byte-binding check
 * accepts.
 */
function buildCommitment(opts: {
  amount: bigint
  channel?: string
  networkPassphrase?: string
  domain?: string
}): Buffer {
  const {
    amount,
    channel = CHANNEL_ADDRESS,
    networkPassphrase = Networks.TESTNET,
    domain = 'chancmmt',
  } = opts
  const networkId = hash(Buffer.from(networkPassphrase))
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal('amount', { type: 'symbol' }),
      val: nativeToScVal(amount, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('channel', { type: 'symbol' }),
      val: new Address(channel).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('domain', { type: 'symbol' }),
      val: nativeToScVal(domain, { type: 'symbol' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('network', { type: 'symbol' }),
      val: xdr.ScVal.scvBytes(networkId),
    }),
  ])
  return map.toXDR()
}

// ── Construction tests ─────────────────────────────────────────────────────

describe('stellar client channel', () => {
  it('creates a client method with correct name and intent', () => {
    const method = makeMethod()
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('channel')
  })

  it('accepts commitmentSecret parameter', () => {
    const method = channel({
      commitmentSecret: TEST_KEYPAIR.secret(),
      allowUnpinnedChannel: true,
    } as Parameters<typeof channel>[0])
    expect(method.name).toBe('stellar')
  })

  it('has createCredential function', () => {
    const method = makeMethod()
    expect(typeof method.createCredential).toBe('function')
  })

  it('throws if neither commitmentKey nor commitmentSecret is provided', () => {
    expect(() => channel({ allowUnpinnedChannel: true } as Parameters<typeof channel>[0])).toThrow(
      'Either commitmentKey or commitmentSecret must be provided.',
    )
  })

  it('requires channel pinning by default unless explicitly opted out', () => {
    expect(() => channel({ commitmentKey: TEST_KEYPAIR })).toThrow('Channel pinning is required')

    const method = channel({
      commitmentKey: TEST_KEYPAIR,
      allowUnpinnedChannel: true,
    } as Parameters<typeof channel>[0])
    expect(method.name).toBe('stellar')
  })
})

// ── createCredential behaviour ─────────────────────────────────────────────

describe('channel createCredential voucher', () => {
  it('signs commitment and produces a valid voucher credential', async () => {
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Decode the credential
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))

    expect(decoded.payload.action).toBe('voucher')
    expect(decoded.payload.amount).toBe('1000000')
    expect(decoded.payload.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('computes cumulative amount from previous + requested', async () => {
    const commitmentBytes = buildCommitment({ amount: 2_500_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge({
      amount: '500000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '2000000', // previous cumulative
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    // 2000000 + 500000 = 2500000
    expect(decoded.payload.amount).toBe('2500000')
  })

  it('produces a close credential with action "close" when requested via context', async () => {
    const commitmentBytes = buildCommitment({ amount: 3_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: { action: 'close', cumulativeAmount: '3000000' } as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))

    expect(decoded.payload.action).toBe('close')
    expect(decoded.payload.amount).toBe('3000000')
    expect(decoded.payload.signature).toMatch(/^[0-9a-f]{128}$/)
    // Close credentials must not carry an open-only transaction field.
    expect(decoded.payload.transaction).toBeUndefined()
  })

  it('allows overriding cumulative amount via context', async () => {
    const commitmentBytes = buildCommitment({ amount: 9_999_999n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: { cumulativeAmount: '9999999' } as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.amount).toBe('9999999')
  })

  it('produces a valid ed25519 signature', async () => {
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    const sigBytes = Buffer.from(decoded.payload.signature, 'hex')

    // Verify the signature with the public key
    const valid = TEST_KEYPAIR.verify(commitmentBytes, sigBytes)
    expect(valid).toBe(true)
  })

  it('fires onProgress events in order', async () => {
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const events: unknown[] = []
    const method = makeMethod({
      onProgress: (e) => events.push(e),
    })
    const challenge = mockChallenge()

    await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    expect(events.length).toBe(3)
    expect((events[0] as any).type).toBe('challenge')
    expect((events[0] as any).channel).toBe(CHANNEL_ADDRESS)
    expect((events[0] as any).cumulativeAmount).toBe('1000000')
    expect((events[1] as any).type).toBe('signing')
    expect((events[2] as any).type).toBe('signed')
    expect((events[2] as any).cumulativeAmount).toBe('1000000')
  })
})

describe('client-side cumulative tracking (store)', () => {
  it('persists signed cumulative to store after signing', async () => {
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory()
    const method = makeMethod({ store })
    const challenge = mockChallenge()

    await method.createCredential({ challenge: challenge as any, context: {} as any })

    const stored = (await store.get(
      `stellar:channel:client:stellar:testnet:${CHANNEL_ADDRESS}:cumulative`,
    )) as {
      amount: string
    }
    expect(stored).not.toBeNull()
    expect(stored.amount).toBe('1000000') // 0 + 1000000
  })

  it('uses locally tracked cumulative over lower server-reported value', async () => {
    const commitmentBytes = buildCommitment({ amount: 6_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory()
    // Simulate client has already committed 5000000 locally
    await store.put(`stellar:channel:client:stellar:testnet:${CHANNEL_ADDRESS}:cumulative`, {
      amount: '5000000',
    })

    const method = makeMethod({ store })
    // Server reports 2000000 even though the locally tracked value is 5000000.
    const challenge = mockChallenge({
      amount: '1000000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '2000000', // server under-reports local state
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    // Uses local (5000000) not server-reported (2000000) as base → 5000000 + 1000000 = 6000000
    expect(decoded.payload.amount).toBe('6000000')
  })

  it('uses server-reported cumulative when no local state exists (first connection)', async () => {
    const commitmentBytes = buildCommitment({ amount: 3_500_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const store = Store.memory() // empty — no prior local state
    const method = makeMethod({ store })
    const challenge = mockChallenge({
      amount: '500000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '3000000', // server reports existing cumulative
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    // No local state → falls back to server-reported 3000000 + 500000 = 3500000
    expect(decoded.payload.amount).toBe('3500000')

    // And persists the new cumulative for next call
    const stored = (await store.get(
      `stellar:channel:client:stellar:testnet:${CHANNEL_ADDRESS}:cumulative`,
    )) as {
      amount: string
    }
    expect(stored.amount).toBe('3500000')
  })

  it('default in-memory store prevents cumulative reset across calls', async () => {
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(buildCommitment({ amount: 1_000_000n })),
    )
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(buildCommitment({ amount: 1_500_000n })),
    )

    const method = makeMethod() // no explicit store

    // First call: server reports cumulative 0, amount 1000000 → signs 1000000
    const challenge1 = mockChallenge({
      amount: '1000000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '0',
      },
    })
    await method.createCredential({ challenge: challenge1 as any, context: {} as any })

    // Second call reports cumulative 0 instead of the previously tracked value.
    const challenge2 = mockChallenge({
      amount: '500000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '0', // lower than the locally tracked value
      },
    })
    const credential2 = await method.createCredential({
      challenge: challenge2 as any,
      context: {} as any,
    })

    const token = credential2.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    // Default in-memory store tracked 1000000 from first call,
    // so it uses max(1000000, 0) + 500000 = 1500000 instead of 0 + 500000
    expect(decoded.payload.amount).toBe('1500000')
  })

  it('defaults to in-memory store when store is omitted', async () => {
    const commitmentBytes = buildCommitment({ amount: 2_500_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod() // defaults to Store.memory()
    const challenge = mockChallenge({
      amount: '500000',
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:testnet',
        cumulativeAmount: '2000000',
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    // In-memory store has no prior state: uses server-reported 2000000 + 500000 = 2500000
    expect(decoded.payload.amount).toBe('2500000')
  })
})

describe('network validation', () => {
  it('throws on unsupported network identifier', async () => {
    const method = makeMethod()
    const challenge = mockChallenge({
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'stellar:futurenet',
        cumulativeAmount: '0',
      },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Unsupported Stellar network identifier: "stellar:futurenet"')
  })

  it('throws on old-style network shorthand', async () => {
    const method = makeMethod()
    const challenge = mockChallenge({
      methodDetails: {
        reference: crypto.randomUUID(),
        network: 'testnet',
        cumulativeAmount: '0',
      },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Unsupported Stellar network identifier: "testnet"')
  })
})

describe('channel pinning (allowedChannels)', () => {
  it('rejects channel address not in allowedChannels list', async () => {
    mockSimulateTransaction.mockClear()

    const method = channel({
      commitmentKey: TEST_KEYPAIR,
      allowedChannels: ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46W'],
    })
    const challenge = mockChallenge({
      channel: CHANNEL_ADDRESS, // different from allowed channel
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Channel address mismatch')

    // Verify simulate was never called (rejection happens before simulation)
    expect(mockSimulateTransaction).not.toHaveBeenCalled()
  })

  it('accepts channel address in allowedChannels list', async () => {
    mockSimulateTransaction.mockClear()
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = channel({
      commitmentKey: TEST_KEYPAIR,
      allowedChannels: [CHANNEL_ADDRESS],
    })
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.signature).toMatch(/^[0-9a-f]{128}$/)

    // Verify simulate was called
    expect(mockSimulateTransaction).toHaveBeenCalled()
  })

  it('accepts channel address when explicitly opting out of pinning', async () => {
    const commitmentBytes = buildCommitment({ amount: 1_000_000n })
    mockSimulateTransaction.mockResolvedValueOnce(successSimResult(commitmentBytes))

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.signature).toMatch(/^[0-9a-f]{128}$/)
  })

  it('emits warning only when allowUnpinnedChannel=true', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnSpy.mockClear()

    makeMethod()

    const allWarnings = warnSpy.mock.calls
    const allWarningsText = allWarnings.map((call) => String(call[0]))

    expect(allWarningsText.some((text) => text.includes('allowUnpinnedChannel=true'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('rejects when allowedChannels is set but channel is not in the list', async () => {
    mockSimulateTransaction.mockClear()

    const allowed = ['CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF46W']
    const method = channel({
      commitmentKey: TEST_KEYPAIR,
      allowedChannels: allowed,
    })
    const challenge = mockChallenge()

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Channel address mismatch')
  })
})

describe('commitment byte-binding', () => {
  it('refuses to sign when the simulated commitment encodes a different amount than intended', async () => {
    // The client intends to sign cumulative 1000000, but the simulation
    // returns a commitment for a different amount; it must refuse to sign.
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(buildCommitment({ amount: 999_999_999n })),
    )

    const method = makeMethod()
    const challenge = mockChallenge() // requests amount 1000000

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/amount mismatch/i)
  })

  it('refuses to sign when the simulated commitment encodes a different channel', async () => {
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(
        buildCommitment({
          amount: 1_000_000n,
          channel: 'CAYGVE5AUQQ2XNXWOXHH5VPGRHYX4APUAOWA4VOBI3VGMOYJ2IJ6VJG5',
        }),
      ),
    )

    const method = makeMethod()
    const challenge = mockChallenge() // pinned/advertised channel is CHANNEL_ADDRESS

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/channel mismatch/i)
  })

  it('signs when the simulated commitment binds to the intended channel and amount', async () => {
    mockSimulateTransaction.mockResolvedValueOnce(
      successSimResult(buildCommitment({ amount: 1_000_000n })),
    )

    const method = makeMethod()
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.signature).toMatch(/^[0-9a-f]{128}$/)
  })
})
