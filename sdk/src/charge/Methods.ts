import { Method } from 'mppx'
import { z } from 'zod/mini'
import { DEFAULT_MAX_XDR_LENGTH } from '../shared/defaults.js'

/**
 * Stellar charge intent for one-time SEP-41 token transfers.
 *
 * Supports three credential flows:
 * - `type: "signedHash"` — **client-broadcast** (push mode, secure):
 *   Client broadcasts the transaction and sends the hash with a source signature.
 *   The server verifies the signature and looks up the hash on-chain.
 * - `type: "hash"` — **client-broadcast** (push mode, legacy receive-only):
 *   Deprecated; supported for backward compatibility with old deployed clients.
 *   Client sends only the transaction hash without a signature.
 *   The server looks it up on-chain. New clients must use `signedHash`.
 * - `type: "transaction"` — **server-broadcast** (pull mode):
 *   Client signs a Soroban SEP-41 `transfer` invocation and sends the
 *   serialised XDR as `payload.transaction`. The server broadcasts it.
 *
 * @see https://paymentauth.org/draft-stellar-charge-00
 */
export const charge = Method.from({
  name: 'stellar',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        /** Push mode (secure): client broadcasts and sends the tx hash with source signature. */
        z.object({
          hash: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
          /**
           * Signature proof that the submitter controls the payer account.
           * The source key's signature over "{challenge.id}:{hash}" (lowercase hash).
           * This lets the server confirm that the credential's source field
           * belongs to the same payer account referenced by the on-chain payment.
           */
          sourceSignature: z.string().check(z.regex(/^[0-9a-f]{128}$/i)),
          type: z.literal('signedHash'),
        }),
        /** Push mode (legacy receive-only): client broadcasts and sends only the tx hash. */
        z.object({
          hash: z.string().check(z.regex(/^[0-9a-f]{64}$/i)),
          type: z.literal('hash'),
        }),
        /** Pull mode: client sends signed XDR as `payload.transaction`, server broadcasts. */
        z.object({
          transaction: z.string().check(z.maxLength(DEFAULT_MAX_XDR_LENGTH)),
          type: z.literal('transaction'),
        }),
      ]),
    },
    request: z.object({
      /** Payment amount in base units (stroops). */
      amount: z.string(),
      /** SEP-41 token contract address (C...) for the token to transfer. */
      currency: z.string(),
      /** Recipient Stellar public key (G...) or contract address (C...). */
      recipient: z.string(),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID (e.g. order ID, invoice number). */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server via request(). */
      methodDetails: z.optional(
        z.object({
          /** CAIP-2 network identifier (e.g. "stellar:testnet", "stellar:pubnet"). */
          network: z.string(),
          /**
           * Whether the server sponsors the transaction.
           *
           * When `true`, the server provides the source account, sequence
           * number, and envelope signature. The client **must** use pull mode
           * (push is rejected) and build with an all-zeros placeholder source,
           * signing only the Soroban authorization entries.
           *
           * This flag is set automatically by the server when a `feePayer`
           * configuration is provided. The optional `feeBumpSigner` within
           * `feePayer` wraps the sponsored transaction in a
           * `FeeBumpTransaction` — it only applies to the sponsored path
           * since unsponsored transactions must be submitted as-is per the
           * spec.
           */
          feePayer: z.optional(z.boolean()),
          /** Credential payload types the server accepts, in order of server preference. */
          credentialTypes: z.optional(z.array(z.string())),
        }),
      ),
    }),
  },
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { toBaseUnits, fromBaseUnits } from '../shared/units.js'
