import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetEvents = vi.fn()
const mockGetLatestLedger = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getEvents = mockGetEvents
        this.getLatestLedger = mockGetLatestLedger
      }),
    },
  }
})

const { watchChannel } = await import('./Watcher.js')

const CHANNEL_ADDRESS = 'CBU3P5BAU6CYGPAVY7TGGGNEPCS7H73IA3L677Z3CFZSGFYB7UFK4IMS'
const TOKEN_ADDRESS = 'CAYGVE5AUQQ2XNXWOXHH5VPGRHYX4APUAOWA4VOBI3VGMOYJ2IJ6VJG5'
const FUNDER = Keypair.random().publicKey()
const RECIPIENT = Keypair.random().publicKey()

function makeSymbolScVal(name: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(name)
}

function makeI128ScVal(amount: bigint): xdr.ScVal {
  const hi = amount >> 64n
  const lo = amount & ((1n << 64n) - 1n)
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(hi.toString()),
      lo: xdr.Uint64.fromString(lo.toString()),
    }),
  )
}

// Builds the map-encoded data section a `#[contractevent]` struct emits: a
// symbol-keyed ScVal::Map with entries sorted by key.
function makeMapScVal(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  const keys = Object.keys(entries).sort()
  return xdr.ScVal.scvMap(
    keys.map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: entries[key] })),
  )
}

function closeData(effectiveAtLedger: number): xdr.ScVal {
  return makeMapScVal({ effective_at_ledger: xdr.ScVal.scvU32(effectiveAtLedger) })
}

function withdrawData(to: string, amount: bigint): xdr.ScVal {
  return makeMapScVal({ to: new Address(to).toScVal(), amount: makeI128ScVal(amount) })
}

function refundData(from: string, amount: bigint): xdr.ScVal {
  return makeMapScVal({ from: new Address(from).toScVal(), amount: makeI128ScVal(amount) })
}

function openData(): xdr.ScVal {
  return makeMapScVal({
    from: new Address(FUNDER).toScVal(),
    to: new Address(RECIPIENT).toScVal(),
    token: new Address(TOKEN_ADDRESS).toScVal(),
    amount: makeI128ScVal(10_000_000n),
    commitment_key: xdr.ScVal.scvBytes(Buffer.alloc(32, 7)),
    refund_waiting_period: xdr.ScVal.scvU32(120),
  })
}

function makeEvent(options: {
  topicName: string
  value?: xdr.ScVal
  txHash?: string
  ledger?: number
}) {
  return {
    id: `event-${Math.random()}`,
    type: 'contract',
    ledger: options.ledger ?? 1000,
    ledgerClosedAt: '2026-03-19T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: options.txHash ?? 'abc123',
    topic: [makeSymbolScVal(options.topicName)],
    value: options.value ?? xdr.ScVal.scvVoid(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mockGetLatestLedger.mockResolvedValue({ id: 'latest', sequence: 5000, protocolVersion: '22' })
  mockGetEvents.mockResolvedValue({ events: [], cursor: '' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('watchChannel', () => {
  it('calls getLatestLedger on first poll to determine startLedger', async () => {
    const events: unknown[] = []
    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => events.push(e),
      intervalMs: 1000,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(mockGetLatestLedger).toHaveBeenCalledOnce()
    expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5000 }))

    stop()
  })

  it('anchors the first poll at the provided startLedger without calling getLatestLedger', async () => {
    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: () => {},
      startLedger: 1234,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(mockGetLatestLedger).not.toHaveBeenCalled()
    expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 1234 }))

    stop()
  })

  it('parses a close event carrying the effective-at ledger (the dispute signal)', async () => {
    const events: unknown[] = []

    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeEvent({
          topicName: 'close',
          value: closeData(5_002_345),
          txHash: 'close-hash',
          ledger: 1001,
        }),
      ],
      cursor: 'cursor-1',
    })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => events.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'close',
      effectiveAtLedger: 5_002_345,
      txHash: 'close-hash',
      ledger: 1001,
      ledgerClosedAt: '2026-03-19T00:00:00Z',
    })

    stop()
  })

  it('parses an open event', async () => {
    const events: unknown[] = []

    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeEvent({ topicName: 'open', value: openData(), txHash: 'open-hash', ledger: 900 }),
      ],
      cursor: 'cursor-open',
    })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => events.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'open',
      from: FUNDER,
      to: RECIPIENT,
      token: TOKEN_ADDRESS,
      amount: 10_000_000n,
      commitmentKey: Buffer.alloc(32, 7).toString('hex'),
      refundWaitingPeriod: 120,
      txHash: 'open-hash',
      ledger: 900,
      ledgerClosedAt: '2026-03-19T00:00:00Z',
    })

    stop()
  })

  it('parses withdraw and refund events', async () => {
    const events: unknown[] = []

    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeEvent({
          topicName: 'withdraw',
          value: withdrawData(RECIPIENT, 3_000_000n),
          txHash: 'withdraw-hash',
        }),
        makeEvent({
          topicName: 'refund',
          value: refundData(FUNDER, 7_000_000n),
          txHash: 'refund-hash',
        }),
      ],
      cursor: 'cursor-3',
    })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => events.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(events).toHaveLength(2)
    expect(events[0]).toEqual({
      type: 'withdraw',
      to: RECIPIENT,
      amount: 3_000_000n,
      txHash: 'withdraw-hash',
      ledger: 1000,
      ledgerClosedAt: '2026-03-19T00:00:00Z',
    })
    expect(events[1]).toEqual({
      type: 'refund',
      from: FUNDER,
      amount: 7_000_000n,
      txHash: 'refund-hash',
      ledger: 1000,
      ledgerClosedAt: '2026-03-19T00:00:00Z',
    })

    stop()
  })

  it('ignores unknown event topics', async () => {
    const events: unknown[] = []

    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeEvent({ topicName: 'some_other_event' }),
        // Topics from the old, incorrect model that the contract never emits.
        makeEvent({ topicName: 'close_start' }),
        makeEvent({ topicName: 'top_up' }),
      ],
      cursor: 'cursor-4',
    })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => events.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(events).toHaveLength(0)

    stop()
  })

  it('uses cursor for subsequent polls', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [makeEvent({ topicName: 'close', value: closeData(5_001_000) })],
        cursor: 'cursor-after-first',
      })
      .mockResolvedValueOnce({
        events: [],
        cursor: '',
      })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      intervalMs: 1000,
      onEvent: () => {},
    })

    // First poll (immediate)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5000 }))

    // Second poll (after interval)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockGetEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-after-first' }),
    )

    stop()
  })

  it('calls onError when polling fails', async () => {
    const errors: Error[] = []
    mockGetEvents.mockRejectedValueOnce(new Error('RPC down'))

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: () => {},
      onError: (e) => errors.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('RPC down')

    stop()
  })

  it('stops polling when stop() is called', async () => {
    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      intervalMs: 1000,
      onEvent: () => {},
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetEvents).toHaveBeenCalledTimes(1)

    stop()

    await vi.advanceTimersByTimeAsync(5000)
    // No additional polls after stop
    expect(mockGetEvents).toHaveBeenCalledTimes(1)
  })

  it('stops polling when AbortSignal is triggered', async () => {
    const controller = new AbortController()

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      intervalMs: 1000,
      onEvent: () => {},
      signal: controller.signal,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetEvents).toHaveBeenCalledTimes(1)

    controller.abort()

    await vi.advanceTimersByTimeAsync(5000)
    expect(mockGetEvents).toHaveBeenCalledTimes(1)

    stop()
  })

  it('does not start if AbortSignal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: () => {},
      signal: controller.signal,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetEvents).not.toHaveBeenCalled()

    stop()
  })

  it('continues delivering events when onEvent callback throws', async () => {
    const errors: Error[] = []
    const events: unknown[] = []
    let callCount = 0

    mockGetEvents.mockResolvedValueOnce({
      events: [
        makeEvent({ topicName: 'close', value: closeData(5_003_000), txHash: 'tx1' }),
        makeEvent({
          topicName: 'withdraw',
          value: withdrawData(RECIPIENT, 2_000_000n),
          txHash: 'tx2',
        }),
      ],
      cursor: 'cursor-after-throw',
    })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      onEvent: (e) => {
        callCount++
        if (callCount === 1) throw new Error('handler boom')
        events.push(e)
      },
      onError: (e) => errors.push(e),
    })

    await vi.advanceTimersByTimeAsync(0)

    // First event threw, but second still delivered
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('handler boom')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'withdraw' })

    stop()
  })

  it('advances cursor even when no events match', async () => {
    mockGetEvents
      .mockResolvedValueOnce({
        events: [],
        cursor: 'cursor-empty-page',
      })
      .mockResolvedValueOnce({
        events: [],
        cursor: 'cursor-empty-page-2',
      })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      intervalMs: 1000,
      onEvent: () => {},
    })

    // First poll — uses startLedger
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 5000 }))

    // Second poll — should use cursor, not startLedger
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockGetEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-empty-page' }),
    )

    stop()
  })

  it('advances cursor when parseEvent throws on a malformed event value', async () => {
    const errors: Error[] = []
    const events: unknown[] = []

    // First event's data is a scalar instead of the map the contract emits, so
    // parsing throws; the second event is valid. Cursor must still advance.
    mockGetEvents
      .mockResolvedValueOnce({
        events: [
          makeEvent({ topicName: 'close', value: makeI128ScVal(5n), txHash: 'bad-tx' }),
          makeEvent({
            topicName: 'withdraw',
            value: withdrawData(RECIPIENT, 500n),
            txHash: 'good-tx',
          }),
        ],
        cursor: 'cursor-after-bad',
      })
      .mockResolvedValueOnce({
        events: [],
        cursor: 'cursor-next',
      })

    const stop = watchChannel({
      channel: CHANNEL_ADDRESS,
      intervalMs: 1000,
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
    })

    // First poll — bad event skipped, good event delivered, cursor advanced
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/non-map data/i)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'withdraw', amount: 500n })

    // Second poll uses the advanced cursor (not stuck on bad event)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockGetEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-after-bad' }),
    )

    stop()
  })
})
