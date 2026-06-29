export const DEFAULT_MAX_FEE_BUMP_STROOPS = 10_000_000
/** Maximum base64-encoded XDR length accepted in credential payloads (~8 KB). */
export const DEFAULT_MAX_XDR_LENGTH = 8_192
export const DEFAULT_POLL_MAX_ATTEMPTS = 20
export const DEFAULT_POLL_DELAY_MS = 1_000
export const DEFAULT_POLL_BACKOFF_MULTIPLIER = 1.2
export const DEFAULT_POLL_JITTER_MS = 200
export const DEFAULT_POLL_TIMEOUT_MS = 20_000
export const DEFAULT_POLL_MAX_CONCURRENT = 10
export const DEFAULT_SIMULATION_TIMEOUT_MS = 10_000

/**
 * Default timeout in seconds for read-only contract getter simulations (State.ts).
 * This is distinct from DEFAULT_SIMULATION_TIMEOUT_MS which is the RPC call timeout
 * in milliseconds. This value is the Soroban transaction `setTimeout()` parameter.
 */
export const DEFAULT_SIM_TIMEOUT_SECS = 30

/**
 * Maximum age, in seconds, of an on-chain payment that push-mode charge
 * settlement will accept. Bounds how far in the past a confirmed transfer may
 * have been included relative to verification time, so a payment made well
 * before the challenge cannot be presented as its settlement.
 */
export const DEFAULT_MAX_PUSH_PAYMENT_AGE_SECONDS = 900
