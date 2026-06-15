import { hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, type NetworkId } from '../constants.js'
import { StellarMppError } from '../shared/errors.js'

/**
 * Domain separator embedded in every one-way-channel commitment
 * (`symbol_short!("chancmmt")` in the contract).
 */
export const COMMITMENT_DOMAIN = 'chancmmt'

/** The values a commitment is expected to bind to before the client signs it. */
export interface ExpectedCommitment {
  /** Channel contract address the client intends to sign for. */
  channel: string
  /** Cumulative amount the client intends to authorise. */
  amount: bigint
  /** Network the commitment must be scoped to. */
  network: NetworkId
}

/**
 * Decodes the XDR `Commitment` returned by `prepare_commitment` and asserts
 * that every field matches the value the client intended to authorise.
 *
 * The commitment bytes are produced by an unauthenticated Soroban simulation,
 * so they are checked against the values the client chose before signing. This
 * keeps the signature tied to the channel, amount, network and domain the
 * client intended.
 *
 * @param commitmentBytes - The bytes returned by `prepare_commitment` (an XDR `ScVal::Map`).
 * @param expected - The channel, amount and network the client intends to sign for.
 * @throws {StellarMppError} If the bytes are not a decodable commitment or any field disagrees.
 */
export function assertCommitmentBinds(
  commitmentBytes: Uint8Array,
  expected: ExpectedCommitment,
): void {
  let decoded: unknown
  try {
    decoded = scValToNative(xdr.ScVal.fromXDR(Buffer.from(commitmentBytes)))
  } catch (error) {
    throw new StellarMppError(
      `Refusing to sign: prepare_commitment did not return a decodable commitment ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    )
  }

  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new StellarMppError(
      'Refusing to sign: commitment bytes did not decode to a commitment struct.',
    )
  }

  const { domain, network, channel, amount } = decoded as {
    domain?: unknown
    network?: unknown
    channel?: unknown
    amount?: unknown
  }

  if (domain !== COMMITMENT_DOMAIN) {
    throw new StellarMppError(
      `Refusing to sign: commitment domain mismatch ` +
        `(expected "${COMMITMENT_DOMAIN}", got "${String(domain)}").`,
    )
  }

  if (channel !== expected.channel) {
    throw new StellarMppError(
      `Refusing to sign: commitment channel mismatch ` +
        `(expected "${expected.channel}", got "${String(channel)}").`,
    )
  }

  let decodedAmount: bigint
  try {
    decodedAmount = BigInt(amount as string | number | bigint)
  } catch {
    throw new StellarMppError(
      `Refusing to sign: commitment amount is not an integer ("${String(amount)}").`,
    )
  }
  if (decodedAmount !== expected.amount) {
    throw new StellarMppError(
      `Refusing to sign: commitment amount mismatch ` +
        `(expected ${expected.amount}, got ${decodedAmount}).`,
    )
  }

  const expectedNetworkId = hash(Buffer.from(NETWORK_PASSPHRASE[expected.network]))
  if (
    !(network instanceof Uint8Array) ||
    Buffer.compare(Buffer.from(network), expectedNetworkId) !== 0
  ) {
    throw new StellarMppError('Refusing to sign: commitment network mismatch.')
  }
}
