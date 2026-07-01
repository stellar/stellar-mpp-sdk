export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/**
 * Races a promise against a timeout so a hung dependency cannot stall the caller
 * indefinitely. Resolves/rejects with the operation's result if it settles
 * first; otherwise rejects with a {@link TimeoutError} after `timeoutMs`.
 *
 * The underlying operation is not cancelled (JavaScript promises are not
 * cancellable) — the timeout only stops the caller from waiting on it.
 *
 * @param operation - The promise to bound.
 * @param timeoutMs - Maximum time to wait before rejecting.
 * @param label - Short description of the operation, used in the timeout message.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
