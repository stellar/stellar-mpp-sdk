import { rpc } from '@stellar/stellar-sdk'

import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_BACKOFF_MULTIPLIER,
  DEFAULT_POLL_JITTER_MS,
  DEFAULT_POLL_TIMEOUT_MS,
} from './defaults.js'
import { StellarMppError } from './errors.js'
import type { Semaphore } from './semaphore.js'

export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PollTimeoutError'
  }
}

export class PollMaxAttemptsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PollMaxAttemptsError'
  }
}

/** The transaction was included in a ledger and failed, leaving contract state unchanged. */
export class TransactionFailedError extends StellarMppError {}

export interface PollOptions {
  maxAttempts?: number
  delayMs?: number
  backoffMultiplier?: number
  jitterMs?: number
  timeoutMs?: number
  /** Semaphore to limit concurrent polls. When provided, `acquire()` is called
   *  before entering the polling loop and `release()` on exit. */
  semaphore?: Semaphore
}

/**
 * Polls Soroban RPC for a transaction result using exponential backoff with jitter.
 *
 * Repeatedly calls `getTransaction` until the transaction reaches a terminal state (`SUCCESS` or
 * `FAILED`) or a timeout / max-attempts limit is hit. If the state is `FAILED`, it throws a
 * {@link TransactionFailedError}.
 *
 * @param rpcServer - Any object exposing a Soroban-compatible `getTransaction` method.
 * @param hash - The hex-encoded transaction hash to poll for.
 * @param opts - Optional polling behaviour overrides.
 * @param opts.maxAttempts - Maximum number of RPC calls before giving up.
 * @param opts.delayMs - Base delay between attempts (before backoff).
 * @param opts.backoffMultiplier - Multiplier applied to `delayMs` on each successive attempt.
 * @param opts.jitterMs - Maximum random jitter added/subtracted from each delay.
 * @param opts.timeoutMs - Hard wall-clock timeout across all attempts.
 * @param opts.semaphore - Optional concurrency limiter.
 * @returns The successful {@link rpc.Api.GetTransactionResponse} once the transaction confirms.
 * @throws {PollTimeoutError} If `timeoutMs` elapses before a terminal status.
 * @throws {PollMaxAttemptsError} If `maxAttempts` is exhausted without a terminal status.
 */
export async function pollTransaction(
  rpcServer: { getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> },
  hash: string,
  opts: PollOptions = {},
) {
  const {
    maxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    delayMs = DEFAULT_POLL_DELAY_MS,
    backoffMultiplier = DEFAULT_POLL_BACKOFF_MULTIPLIER,
    jitterMs = DEFAULT_POLL_JITTER_MS,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    semaphore,
  } = opts

  if (semaphore) await semaphore.acquire()
  try {
    const startTime = Date.now()
    let attempts = 0

    while (true) {
      if (Date.now() - startTime > timeoutMs) {
        throw new PollTimeoutError(`Poll timed out after ${timeoutMs}ms for transaction ${hash}`)
      }

      const result = await rpcServer.getTransaction(hash)

      if (result.status === 'SUCCESS') {
        return result
      }

      if (result.status === 'FAILED') {
        throw new TransactionFailedError(
          `Transaction ${hash} failed: ${result.resultXdr ?? 'unknown error'}`,
        )
      }

      attempts++
      if (attempts >= maxAttempts) {
        throw new PollMaxAttemptsError(
          `Transaction ${hash} not found after ${maxAttempts} attempts`,
        )
      }

      const baseDelay = delayMs * Math.pow(backoffMultiplier, attempts - 1)
      const jitter = (Math.random() * 2 - 1) * jitterMs
      const delay = Math.max(0, baseDelay + jitter)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  } finally {
    if (semaphore) semaphore.release()
  }
}
