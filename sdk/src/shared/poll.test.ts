import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pollTransaction, PollTimeoutError, PollMaxAttemptsError } from './poll.js'

type PollRpc = Parameters<typeof pollTransaction>[0]

function createMockRpc(responses: Array<{ status: string; [k: string]: unknown }>): PollRpc {
  let callIndex = 0
  return {
    getTransaction: vi.fn(async () => {
      if (callIndex >= responses.length) {
        return responses[responses.length - 1]
      }
      return responses[callIndex++]
    }),
  } as unknown as PollRpc
}

describe('pollTransaction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns result on immediate SUCCESS status', async () => {
    const rpc = createMockRpc([{ status: 'SUCCESS', resultXdr: 'abc' }])

    const result = await pollTransaction(rpc, 'tx-hash-1')

    expect(result).toEqual({ status: 'SUCCESS', resultXdr: 'abc' })
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1)
    expect(rpc.getTransaction).toHaveBeenCalledWith('tx-hash-1')
  })

  it('retries on NOT_FOUND then succeeds on next attempt', async () => {
    const rpc = createMockRpc([{ status: 'NOT_FOUND' }, { status: 'SUCCESS', resultXdr: 'def' }])

    const promise = pollTransaction(rpc, 'tx-hash-2', {
      delayMs: 100,
      backoffMultiplier: 1,
      jitterMs: 0,
    })

    // First call returns NOT_FOUND, then waits for delay
    await vi.advanceTimersByTimeAsync(100)

    const result = await promise

    expect(result).toEqual({ status: 'SUCCESS', resultXdr: 'def' })
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2)
  })

  it('throws on FAILED status with details', async () => {
    const rpc = createMockRpc([{ status: 'FAILED', resultXdr: 'some-error-xdr' }])

    await expect(pollTransaction(rpc, 'tx-hash-3')).rejects.toThrow(
      'Transaction tx-hash-3 failed: some-error-xdr',
    )
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1)
  })

  it('throws PollTimeoutError on wall-clock timeout', async () => {
    const rpc = createMockRpc([{ status: 'NOT_FOUND' }])

    let caughtError: unknown
    const promise = pollTransaction(rpc, 'tx-hash-4', {
      timeoutMs: 500,
      delayMs: 100,
      backoffMultiplier: 1,
      jitterMs: 0,
    }).catch((err) => {
      caughtError = err
    })

    // Advance time past the timeout
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }

    await promise

    expect(caughtError).toBeInstanceOf(PollTimeoutError)
    expect((caughtError as Error).message).toMatch(/timed out after 500ms/)
  })

  it('throws PollMaxAttemptsError when max attempts exceeded', async () => {
    const rpc = createMockRpc([{ status: 'NOT_FOUND' }])

    let caughtError: unknown
    const promise = pollTransaction(rpc, 'tx-hash-5', {
      maxAttempts: 3,
      delayMs: 10,
      backoffMultiplier: 1,
      jitterMs: 0,
      timeoutMs: 60_000,
    }).catch((err) => {
      caughtError = err
    })

    // Advance through all retry delays
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10)
    }

    await promise

    expect(caughtError).toBeInstanceOf(PollMaxAttemptsError)
    expect((caughtError as Error).message).toMatch(/not found after 3 attempts/)
  })

  it('applies exponential backoff between retries', async () => {
    const rpc = createMockRpc([
      { status: 'NOT_FOUND' },
      { status: 'NOT_FOUND' },
      { status: 'NOT_FOUND' },
      { status: 'SUCCESS', resultXdr: 'ok' },
    ])

    const promise = pollTransaction(rpc, 'tx-backoff', {
      delayMs: 100,
      backoffMultiplier: 2,
      jitterMs: 0,
      timeoutMs: 60_000,
    })

    // 1st retry delay: 100 * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100)
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2)

    // 2nd retry delay: 100 * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200)
    expect(rpc.getTransaction).toHaveBeenCalledTimes(3)

    // 3rd retry delay: 100 * 2^2 = 400ms
    await vi.advanceTimersByTimeAsync(400)
    expect(rpc.getTransaction).toHaveBeenCalledTimes(4)

    const result = await promise
    expect(result).toEqual({ status: 'SUCCESS', resultXdr: 'ok' })
  })

  it('throws immediately on RPC network error', async () => {
    const rpc = {
      getTransaction: vi.fn(async () => {
        throw new Error('Network error: connection refused')
      }),
    }

    await expect(pollTransaction(rpc, 'tx-hash-6')).rejects.toThrow(
      'Network error: connection refused',
    )
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1)
  })
})
