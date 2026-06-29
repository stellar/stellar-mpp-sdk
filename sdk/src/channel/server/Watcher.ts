import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk'
import { SOROBAN_RPC_URLS, STELLAR_TESTNET, type NetworkId } from '../../constants.js'
import { StellarMppError } from '../../shared/errors.js'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * A one-way payment channel contract event, decoded from the on-chain
 * `#[contractevent]` representation (single lower-snake-case topic, map data).
 *
 * The `close` event is the dispute signal: it is emitted by both `close_start`
 * (with a future `effectiveAtLedger`, opening the refund waiting period) and
 * `close` (effective at the current ledger). A recipient must settle before
 * `effectiveAtLedger`.
 */
export type ChannelEvent =
  | {
      type: 'open'
      from: string
      to: string
      token: string
      amount: bigint
      commitmentKey: string
      refundWaitingPeriod: number
      txHash: string
      ledger: number
      ledgerClosedAt: string
    }
  | {
      type: 'close'
      effectiveAtLedger: number
      txHash: string
      ledger: number
      ledgerClosedAt: string
    }
  | {
      type: 'withdraw'
      to: string
      amount: bigint
      txHash: string
      ledger: number
      ledgerClosedAt: string
    }
  | {
      type: 'refund'
      from: string
      amount: bigint
      txHash: string
      ledger: number
      ledgerClosedAt: string
    }

const KNOWN_TOPICS = new Set(['open', 'close', 'withdraw', 'refund'])

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * Polls Soroban RPC for contract events on a one-way payment channel.
 *
 * @returns A stop function that cancels the polling loop.
 *
 * @example
 * ```ts
 * import { watchChannel } from '@stellar/mpp/channel/server'
 *
 * const stop = watchChannel({
 *   channel: 'CABC...',
 *   onEvent(event) {
 *     if (event.type === 'close') {
 *       console.log('Channel close initiated — settle before ledger', event.effectiveAtLedger)
 *     }
 *   },
 * })
 *
 * // Later, stop watching:
 * stop()
 * ```
 */
export function watchChannel(parameters: watchChannel.Parameters): () => void {
  const {
    channel,
    network = STELLAR_TESTNET,
    rpcUrl,
    intervalMs = 5_000,
    onEvent,
    onError,
    signal,
    startLedger: initialStartLedger,
  } = parameters

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const server = new rpc.Server(resolvedRpcUrl)

  let cursor: string | undefined
  let startLedger: number | undefined
  let timerResolve: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function init() {
    if (startLedger != null) return
    if (initialStartLedger != null) {
      startLedger = initialStartLedger
      return
    }
    const latest = await server.getLatestLedger()
    startLedger = latest.sequence
  }

  async function poll() {
    if (stopped) return

    try {
      await init()

      const request: rpc.Api.GetEventsRequest = cursor
        ? {
            filters: [
              {
                type: 'contract' as const,
                contractIds: [channel],
                topics: [['*']],
              },
            ],
            cursor,
          }
        : {
            filters: [
              {
                type: 'contract' as const,
                contractIds: [channel],
                topics: [['*']],
              },
            ],
            startLedger: startLedger!,
          }

      const response = await server.getEvents(request)

      // Check stopped after await to avoid emitting events after shutdown
      if (stopped) return

      for (const event of response.events) {
        let parsed: ChannelEvent | null
        try {
          parsed = parseEvent(event)
        } catch (parseError) {
          try {
            onError?.(parseError instanceof Error ? parseError : new Error(String(parseError)))
          } catch {
            /* prevent onError from breaking the poll loop */
          }
          continue
        }
        if (parsed) {
          try {
            onEvent(parsed)
          } catch (callbackError) {
            try {
              onError?.(
                callbackError instanceof Error ? callbackError : new Error(String(callbackError)),
              )
            } catch {
              /* prevent onError from breaking the poll loop */
            }
          }
        }
      }

      // Always advance cursor so polling progresses even when no
      // events match — without this the watcher would re-scan the
      // same ledger range on every poll.
      if (response.cursor != null) {
        cursor = response.cursor
      }
    } catch (error) {
      if (!stopped) {
        try {
          onError?.(error instanceof Error ? error : new Error(String(error)))
        } catch {
          /* prevent onError from breaking the poll loop */
        }
      }
    }
  }

  function stop() {
    stopped = true
    if (timer != null) {
      clearTimeout(timer)
      timer = undefined
    }
    // Unblock the sleep promise so the loop can exit promptly
    timerResolve?.()
    timerResolve = undefined
    // Clean up the abort listener to prevent leaks if the signal outlives the watcher
    if (signal) signal.removeEventListener('abort', stop)
  }

  async function runLoop() {
    while (!stopped) {
      await poll()
      if (stopped) break
      await new Promise<void>((resolve) => {
        timerResolve = resolve
        timer = setTimeout(() => {
          timerResolve = undefined
          timer = undefined
          resolve()
        }, intervalMs)
      })
      timerResolve = undefined
      timer = undefined
    }
  }

  if (signal) {
    if (signal.aborted) {
      stopped = true
      return stop
    }
    signal.addEventListener('abort', stop, { once: true })
  }

  // Start the polling loop immediately
  void runLoop()

  return stop
}

export declare namespace watchChannel {
  interface Parameters {
    /** Channel contract address (C...). */
    channel: string
    /** Network identifier. Defaults to 'stellar:testnet'. */
    network?: NetworkId
    /** Custom Soroban RPC URL. */
    rpcUrl?: string
    /** Polling interval in milliseconds. Defaults to 5000. */
    intervalMs?: number
    /**
     * Ledger sequence to begin watching from. When provided, the watcher anchors
     * its first poll here instead of the latest ledger, so a recipient can resume
     * across a restart without missing events (such as a close) emitted while it
     * was down. When omitted, watching starts at the latest ledger.
     */
    startLedger?: number
    /** Called for each channel event. */
    onEvent: (event: ChannelEvent) => void
    /** Called when a polling error occurs. */
    onError?: (error: Error) => void
    /** AbortSignal for clean shutdown. */
    signal?: AbortSignal
  }
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

function parseEvent(event: rpc.Api.EventResponse): ChannelEvent | null {
  if (!event.topic || event.topic.length === 0) return null

  const topicName = decodeSymbol(event.topic[0])
  if (!topicName || !KNOWN_TOPICS.has(topicName)) return null

  const { txHash, ledger, ledgerClosedAt } = event

  // Every channel event encodes its fields as a `#[contractevent]` map.
  const data = scValToNative(event.value)
  if (typeof data !== 'object' || data === null) {
    throw new StellarMppError(`Channel ${topicName} event has unexpected non-map data.`)
  }
  const fields = data as Record<string, unknown>

  switch (topicName) {
    case 'open':
      return {
        type: 'open',
        from: String(fields.from),
        to: String(fields.to),
        token: String(fields.token),
        amount: BigInt(fields.amount as bigint),
        commitmentKey: Buffer.from(fields.commitment_key as Uint8Array).toString('hex'),
        refundWaitingPeriod: Number(fields.refund_waiting_period),
        txHash,
        ledger,
        ledgerClosedAt,
      }
    case 'close':
      return {
        type: 'close',
        effectiveAtLedger: Number(fields.effective_at_ledger),
        txHash,
        ledger,
        ledgerClosedAt,
      }
    case 'withdraw':
      return {
        type: 'withdraw',
        to: String(fields.to),
        amount: BigInt(fields.amount as bigint),
        txHash,
        ledger,
        ledgerClosedAt,
      }
    case 'refund':
      return {
        type: 'refund',
        from: String(fields.from),
        amount: BigInt(fields.amount as bigint),
        txHash,
        ledger,
        ledgerClosedAt,
      }
    default:
      return null
  }
}

function decodeSymbol(scVal: xdr.ScVal): string | null {
  try {
    if (scVal.switch().value === xdr.ScValType.scvSymbol().value) {
      return scVal.sym().toString()
    }
  } catch {
    // Not a symbol
  }
  return null
}
