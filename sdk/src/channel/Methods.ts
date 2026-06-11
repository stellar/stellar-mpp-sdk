import { Method } from 'mppx'
import { z } from 'zod/mini'

/**
 * Stellar one-way payment channel intent.
 *
 * Instead of settling each payment on-chain, the funder signs
 * cumulative commitments off-chain. The recipient can close the channel
 * on-chain at any time using the latest commitment.
 *
 * @see https://github.com/stellar-experimental/one-way-channel
 */
export const channel = Method.from({
  name: 'stellar',
  intent: 'channel',
  schema: {
    credential: {
      payload: z.union([
        z.object({
          /** Action discriminator — pay a voucher. */
          action: z.literal('voucher'),
          /** Cumulative amount authorised by this commitment (base units). */
          amount: z.string().check(z.regex(/^\d+$/)),
          /** Ed25519 signature over the commitment bytes (128 hex chars). */
          signature: z.string().check(z.regex(/^[0-9a-f]{128}$/i)),
        }),
        z.object({
          /** Action discriminator — close the channel. */
          action: z.literal('close'),
          /** Cumulative amount authorised by this commitment (base units). */
          amount: z.string().check(z.regex(/^\d+$/)),
          /** Ed25519 signature over the commitment bytes (128 hex chars). */
          signature: z.string().check(z.regex(/^[0-9a-f]{128}$/i)),
        }),
      ]),
    },
    request: z.object({
      /** Incremental payment amount in base units (stroops). */
      amount: z.string(),
      /** On-chain channel contract address (C...). */
      channel: z.string(),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID. */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server. */
      methodDetails: z.optional(
        z.object({
          /** Server-generated unique tracking ID. */
          reference: z.optional(z.string()),
          /** Stellar network identifier ("public" | "testnet"). */
          network: z.optional(z.string()),
          /** Cumulative amount already committed up to this point (base units). */
          cumulativeAmount: z.optional(z.string()),
        }),
      ),
    }),
  },
})
