import { StrKey } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, STELLAR_TESTNET, type NetworkId } from '../constants.js'
import { StellarMppError } from './errors.js'

/**
 * Validates that a string is well-formed hex of a specific length.
 *
 * @param hex - The hex string to validate.
 * @param expectedLength - Required character count (must be even). Defaults to 128 (64-byte ed25519 signature).
 * @throws {StellarMppError} If the string is not valid hex or has the wrong length.
 */
export function validateHexSignature(hex: string, expectedLength: number = 128): void {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== expectedLength) {
    throw new StellarMppError(
      `Invalid signature: expected ${expectedLength} hex characters, got ${hex.length}`,
    )
  }
}

/**
 * Resolves an unknown value to a valid {@link NetworkId}.
 *
 * Returns `stellar:testnet` when `network` is nullish. Throws for
 * unrecognised identifiers (including legacy `"testnet"` / `"public"` strings).
 *
 * @param network - Raw network value (typically from a challenge's `methodDetails`).
 * @returns A validated {@link NetworkId}.
 * @throws {StellarMppError} If the value is not a supported network identifier.
 */
export function resolveNetworkId(network: unknown): NetworkId {
  if (network == null) return STELLAR_TESTNET
  if (typeof network === 'string' && network in NETWORK_PASSPHRASE) return network as NetworkId
  const supported = Object.keys(NETWORK_PASSPHRASE).join(', ')
  throw new StellarMppError(
    `Unsupported Stellar network identifier: "${network}". Supported networks: ${supported}`,
  )
}

/**
 * Validates that `address` is a well-formed Stellar contract address (C...).
 *
 * The channel address is server-supplied on the client, and an invalid
 * value would otherwise surface as an untyped `Error` from the `Address`
 * constructor inside commitment encoding.
 *
 * @param address - The value to validate.
 * @throws {StellarMppError} If the value is not a valid contract address.
 */
export function validateContractAddress(address: unknown): void {
  if (typeof address !== 'string' || !StrKey.isValidContract(address)) {
    throw new StellarMppError(
      `Invalid contract address: "${String(address)}" must be a valid Stellar contract address (C...)`,
    )
  }
}

/**
 * Validates a configured numeric bound.
 *
 * Bounds such as fee ceilings, send caps, timeouts and concurrency limits are
 * compared with `>`, and a zero or negative value would disable or stall them.
 * `NaN` or `Infinity` would never trip a comparison, so they are rejected up front.
 *
 * @param name - The option name, used in the error message.
 * @param value - The configured value.
 * @throws {StellarMppError} If the value is not a positive safe integer.
 */
export function validatePositiveSafeInteger(name: string, value: number): void {
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new StellarMppError(`\`${name}\` must be a positive safe integer.`, {
      [name]: String(value),
    })
  }
}

/**
 * Validates a configured numeric option where zero is a meaningful value,
 * such as a poll delay of 0 or a token with 0 decimal places.
 *
 * @param name - The option name, used in the error message.
 * @param value - The configured value.
 * @throws {StellarMppError} If the value is not a non-negative safe integer.
 */
export function validateNonNegativeSafeInteger(name: string, value: number): void {
  if (!(Number.isSafeInteger(value) && value >= 0)) {
    throw new StellarMppError(`\`${name}\` must be a non-negative safe integer.`, {
      [name]: String(value),
    })
  }
}

/** Largest value representable by a signed 128-bit integer (Soroban `i128`). */
export const I128_MAX = 2n ** 127n - 1n

/**
 * Validates that `amount` is a positive integer string with no leading zeros and
 * does not exceed the signed `i128` maximum.
 *
 * Intended for base-unit (stroops) values before they are converted to `BigInt`
 * and then to a Soroban `i128` ScVal. The upper bound is required because
 * `nativeToScVal(value, { type: 'i128' })` throws an untyped `RangeError` for
 * out-of-range magnitudes; bounding here keeps the failure a typed
 * {@link StellarMppError}.
 *
 * @param amount - The string to validate.
 * @throws {StellarMppError} If the string is not a strictly positive integer
 *   without leading zeros, or if it exceeds the signed i128 maximum.
 */
export function validateAmount(amount: string): void {
  if (!/^[1-9]\d*$/.test(amount)) {
    throw new StellarMppError(
      `Invalid amount: "${amount}" must be a positive integer string without leading zeros`,
    )
  }
  if (BigInt(amount) > I128_MAX) {
    throw new StellarMppError(
      `Invalid amount: "${amount}" exceeds the signed i128 maximum (${I128_MAX.toString()})`,
    )
  }
}
