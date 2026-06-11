import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr as StellarXdr,
} from '@stellar/stellar-sdk'
import { Credential, Method } from 'mppx'
import { z } from 'zod/mini'
import {
  ALL_ZEROS,
  DEFAULT_DECIMALS,
  DEFAULT_LEDGER_CLOSE_TIME,
  DEFAULT_TIMEOUT,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
} from '../../constants.js'
import * as Methods from '../Methods.js'
import { fromBaseUnits } from '../Methods.js'
import { StellarMppError } from '../../shared/errors.js'
import { resolveKeypair } from '../../shared/keypairs.js'
import { resolveNetworkId } from '../../shared/validation.js'
import { pollTransaction } from '../../shared/poll.js'
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SIMULATION_TIMEOUT_MS,
} from '../../shared/defaults.js'

/**
 * Creates a Stellar charge method for use on the **client**.
 *
 * Builds a Soroban SEP-41 `transfer` invocation, signs it, and either:
 * - **pull** (default): sends the signed XDR to the server to broadcast
 * - **push**: broadcasts itself and sends the tx hash
 *
 * @see https://paymentauth.org/draft-stellar-charge-00
 *
 * @example
 * ```ts
 * import { Keypair } from '@stellar/stellar-sdk'
 * import { Mppx } from 'mppx/client'
 * import { stellar } from '@stellar/mpp/charge/client'
 *
 * Mppx.create({
 *   methods: [
 *     stellar.charge({
 *       keypair: Keypair.fromSecret('S...'),
 *     }),
 *   ],
 * })
 *
 * const response = await fetch('https://api.example.com/resource')
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    decimals = DEFAULT_DECIMALS,
    keypair: keypairParam,
    mode: defaultMode = 'pull',
    onProgress,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    rpcUrl,
    secretKey,
    simulationTimeoutMs: _simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
    timeout = DEFAULT_TIMEOUT,
  } = parameters

  if (!keypairParam && !secretKey) {
    throw new StellarMppError('Either keypair or secretKey must be provided.')
  }

  const clientKP = keypairParam ?? resolveKeypair(secretKey!)

  return Method.toClient(Methods.charge, {
    context: z.object({
      mode: z.optional(z.enum(['push', 'pull'])),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, currency, recipient } = request

      const network = resolveNetworkId(request.methodDetails?.network)

      onProgress?.({
        type: 'challenge',
        recipient,
        amount: fromBaseUnits(amount, decimals),
        currency,
      })

      const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
      const networkPassphrase = NETWORK_PASSPHRASE[network]
      const server = new rpc.Server(resolvedRpcUrl)

      // Build SEP-41 `transfer(from, to, amount)` invocation
      const contract = new Contract(currency)
      const stellarAmount = BigInt(amount)

      const effectiveMode = context?.mode ?? defaultMode
      const isServerSponsored = request.methodDetails?.feePayer === true
      const advertizedCredentialTypes = request.methodDetails?.credentialTypes

      if (isServerSponsored && effectiveMode === 'push') {
        throw new StellarMppError(
          'Push mode is not supported for server-sponsored transactions. ' +
            "The server must submit sponsored transactions. Use mode: 'pull' (default).",
        )
      }

      // ── Fail-fast credential type validation ────────────────────────────────
      // Before building/broadcasting, verify the server accepts the intended credential type.
      // This prevents fund loss in push mode where the client broadcasts before getting feedback.

      if (effectiveMode === 'push') {
        // Push mode REQUIRES the server to advertise signedHash support
        if (!advertizedCredentialTypes || !advertizedCredentialTypes.includes('signedHash')) {
          throw new StellarMppError(
            'Server does not accept secure push credentials (signedHash). ' +
              'Either upgrade the server to support signedHash, ' +
              'or switch to pull mode (default). ' +
              'Do not fall back to legacy unsigned hash mode.',
          )
        }
      } else {
        // Pull mode: REQUIRES the server to advertise transaction support
        // (legacy servers without credentialTypes field implicitly support transaction)
        if (advertizedCredentialTypes && !advertizedCredentialTypes.includes('transaction')) {
          throw new StellarMppError(
            'Server does not accept pull mode credentials (transaction). ' +
              'This server only accepts: ' +
              advertizedCredentialTypes.join(', ') +
              '. Switch to an advertised credential type or upgrade the server.',
          )
        }
      }

      const expiresTimestamp: number | undefined = challenge.expires
        ? Math.floor(new Date(challenge.expires).getTime() / 1000)
        : undefined

      if (isServerSponsored) {
        // ── Spec-compliant sponsored path ──────────────────────────────────
        // Client uses an all-zeros source account so the server can swap in
        // its own fee-payer account when rebuilding the transaction.
        const placeholderSource = new Account(ALL_ZEROS, '0')

        const transferOp = contract.call(
          'transfer',
          new Address(clientKP.publicKey()).toScVal(),
          new Address(recipient).toScVal(),
          nativeToScVal(stellarAmount, { type: 'i128' }),
        )

        const sponsoredBuilder = new TransactionBuilder(placeholderSource, {
          fee: BASE_FEE,
          networkPassphrase,
        }).addOperation(transferOp)

        if (expiresTimestamp) {
          sponsoredBuilder.setTimebounds(0, expiresTimestamp)
        } else {
          sponsoredBuilder.setTimeout(timeout)
        }

        const unsignedTx = sponsoredBuilder.build()
        const prepared = await server.prepareTransaction(unsignedTx)

        const latestLedger = await server.getLatestLedger()
        let validUntilLedger: number
        if (expiresTimestamp) {
          const nowSecs = Math.floor(Date.now() / 1000)
          const secsUntilExpiry = Math.max(expiresTimestamp - nowSecs, 0)
          validUntilLedger =
            latestLedger.sequence + Math.ceil(secsUntilExpiry / DEFAULT_LEDGER_CLOSE_TIME)
        } else {
          validUntilLedger =
            latestLedger.sequence + Math.ceil(timeout / DEFAULT_LEDGER_CLOSE_TIME) + 10
        }

        onProgress?.({ type: 'signing' })

        // Sign only the Soroban authorization entries — do NOT sign the
        // transaction envelope (the server will do that after rebuilding).
        const envelope = prepared.toEnvelope()
        const v1 = envelope.v1()
        for (const op of v1.tx().operations()) {
          const body = op.body()
          if (body.switch().value !== StellarXdr.OperationType.invokeHostFunction().value) {
            continue
          }
          const authEntries = body.invokeHostFunctionOp().auth()
          for (let i = 0; i < authEntries.length; i++) {
            const entry = authEntries[i]
            if (
              entry.credentials().switch().value ===
              StellarXdr.SorobanCredentialsType.sorobanCredentialsAddress().value
            ) {
              authEntries[i] = await authorizeEntry(
                entry,
                clientKP,
                validUntilLedger,
                networkPassphrase,
              )
            }
          }
        }

        const signedXdr = envelope.toXDR('base64')
        onProgress?.({ type: 'signed', transaction: signedXdr })

        const source = `did:pkh:${network}:${clientKP.publicKey()}`

        return Credential.serialize({
          challenge,
          payload: { type: 'transaction' as const, transaction: signedXdr },
          source,
        })
      }

      // ── Standard (unsponsored) path ────────────────────────────────────────
      // Client builds and signs the full transaction; server submits as-is
      // (or wraps it in a fee bump if it has a configured fee payer).
      const sourceAccount = await server.getAccount(clientKP.publicKey())

      const transferOp = contract.call(
        'transfer',
        new Address(clientKP.publicKey()).toScVal(),
        new Address(recipient).toScVal(),
        nativeToScVal(stellarAmount, { type: 'i128' }),
      )

      const builder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      }).addOperation(transferOp)

      if (expiresTimestamp) {
        builder.setTimebounds(0, expiresTimestamp)
      } else {
        builder.setTimeout(timeout)
      }

      const transaction = builder.build()

      // Simulate to attach Soroban resource data
      const prepared = await server.prepareTransaction(transaction)

      onProgress?.({ type: 'signing' })
      prepared.sign(clientKP)

      const signedXdr = prepared.toXDR()
      onProgress?.({ type: 'signed', transaction: signedXdr })

      const source = `did:pkh:${network}:${clientKP.publicKey()}`

      if (effectiveMode === 'push') {
        // Client broadcasts
        onProgress?.({ type: 'paying' })
        const result = await server.sendTransaction(prepared)

        if (result.status === 'ERROR' || result.status === 'DUPLICATE') {
          throw new StellarMppError(`Broadcast failed: sendTransaction returned ${result.status}.`)
        }

        // Poll until confirmed
        onProgress?.({ type: 'confirming', hash: result.hash })
        await pollTransaction(server, result.hash, {
          maxAttempts: pollMaxAttempts,
          delayMs: pollDelayMs,
          timeoutMs: pollTimeoutMs,
        })

        onProgress?.({ type: 'paid', hash: result.hash })

        // Sign the canonical hash and challenge ID to prove control of the payer
        const canonicalHash = result.hash.toLowerCase()
        const bindingMessage = Buffer.from(`${challenge.id}:${canonicalHash}`)
        const sourceSignature = Buffer.from(clientKP.sign(bindingMessage)).toString('hex')

        return Credential.serialize({
          challenge,
          payload: {
            type: 'signedHash' as const,
            hash: result.hash,
            sourceSignature,
          },
          source,
        })
      }

      // Pull mode: send signed XDR for server to broadcast
      return Credential.serialize({
        challenge,
        payload: { type: 'transaction' as const, transaction: signedXdr },
        source,
      })
    },
  })
}

export declare namespace charge {
  type ProgressEvent =
    | { type: 'challenge'; recipient: string; amount: string; currency: string }
    | { type: 'signing' }
    | { type: 'signed'; transaction: string }
    | { type: 'paying' }
    | { type: 'confirming'; hash: string }
    | { type: 'paid'; hash: string }

  type Parameters = {
    /** Stellar secret key (S...). Provide either this or `keypair`. */
    secretKey?: string
    /** Stellar Keypair instance. Provide either this or `secretKey`. */
    keypair?: Keypair
    /** Number of decimal places for the token. @default 7 */
    decimals?: number
    /** Custom Soroban RPC URL. Defaults based on network. */
    rpcUrl?: string
    /**
     * Controls how the charge transaction is submitted.
     *
     * - `'push'`: Client broadcasts the transaction and sends the tx hash.
     * - `'pull'`: Client signs the transaction and sends the signed XDR
     *   to the server for broadcast.
     *
     * @default 'pull'
     */
    mode?: 'push' | 'pull'
    /** Transaction timeout in seconds. @default 180 */
    timeout?: number
    /** Callback invoked at each lifecycle stage. */
    onProgress?: (event: ProgressEvent) => void
    /** Maximum polling attempts. @default 20 */
    pollMaxAttempts?: number
    /** Delay between poll attempts in ms. @default 1_000 */
    pollDelayMs?: number
    /** Overall poll timeout in ms. @default 20_000 */
    pollTimeoutMs?: number
    /** Simulation timeout in ms. @default 10_000 */
    simulationTimeoutMs?: number
  }
}
