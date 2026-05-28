import { rpc, xdr } from '@stellar/stellar-sdk'
import { SOROBAN_RPC_URLS, STELLAR_TESTNET, type NetworkId } from '../../constants.js'
import { scValToBigInt } from '../../shared/scval.js'

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type ChannelEvent =
  | { type: 'close'; amount: bigint; txHash: string; ledger: number; ledgerClosedAt: string }
  | { type: 'close_start'; txHash: string; ledger: number; ledgerClosedAt: string }
  | { type: 'refund'; amount: bigint; txHash: string; ledger: number; ledgerClosedAt: string }
  | { type: 'top_up'; amount: bigint; txHash: string; ledger: number; ledgerClosedAt: string }

const KNOWN_TOPICS = new Set(['close', 'close_start', 'refund', 'top_up'])

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
 *     if (event.type === 'close_start') {
 *       console.log('Dispute opened — respond before timeout!')
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

  switch (topicName) {
    case 'close':
      return { type: 'close', amount: scValToBigInt(event.value), txHash, ledger, ledgerClosedAt }
    case 'close_start':
      return { type: 'close_start', txHash, ledger, ledgerClosedAt }
    case 'refund':
      return { type: 'refund', amount: scValToBigInt(event.value), txHash, ledger, ledgerClosedAt }
    case 'top_up':
      return { type: 'top_up', amount: scValToBigInt(event.value), txHash, ledger, ledgerClosedAt }
    default:
      return null
  }
}

function decodeSymbol(scVal: xdr.ScVal): string | null {
  try {
    if (scVal.type === 'scvSymbol') {
      return scVal.value
    }
  } catch {
    // Not a symbol
  }
  return null
}
