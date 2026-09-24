import { Address, hash, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'
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
 * Builds the commitment message locally. The bytes are identical to the bytes
 * that the one-way-channel contract returns from `prepare_commitment`.
 *
 * The message is the XDR of an `ScVal::Map`. The map holds four entries:
 * `amount`, `channel`, `domain` and `network`. Soroban requires ascending key
 * order, and these four keys are already in that order.
 *
 * This function knows every field before a request arrives. The amount comes
 * from the voucher. The channel and the network come from the configuration.
 * The domain is a constant. No field depends on chain state, so this function
 * makes no RPC call.
 *
 * A local build also removes a trust dependency. Nothing authenticates a
 * simulation result, so the caller must check each field of the fetched bytes
 * before it signs them. Refer to {@link assertCommitmentBinds}. Bytes from this
 * function always bind to the supplied channel, amount and network.
 *
 * One risk remains: this encoding can become different from the contract
 * encoding. The live parity test in `integration/live` finds that difference.
 * The test compares this output with the output of a real `prepare_commitment`
 * call.
 *
 * @param expected - The channel, amount and network for the commitment.
 * @returns The XDR-encoded commitment bytes. The client signs these bytes.
 */
export function buildCommitmentMessage(expected: ExpectedCommitment): Buffer {
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE[expected.network]))
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal('amount', { type: 'symbol' }),
      val: nativeToScVal(expected.amount, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('channel', { type: 'symbol' }),
      val: new Address(expected.channel).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('domain', { type: 'symbol' }),
      val: nativeToScVal(COMMITMENT_DOMAIN, { type: 'symbol' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('network', { type: 'symbol' }),
      val: xdr.ScVal.scvBytes(networkId),
    }),
  ]).toXDR()
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
