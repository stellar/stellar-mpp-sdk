import {
  Account,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { Credential, Method, Store } from 'mppx'
import { z } from 'zod/mini'
import { ALL_ZEROS, DEFAULT_FEE, NETWORK_PASSPHRASE, SOROBAN_RPC_URLS } from '../../constants.js'
import { DEFAULT_SIMULATION_TIMEOUT_MS } from '../../shared/defaults.js'
import { StellarMppError } from '../../shared/errors.js'
import { simulateCall } from '../../shared/simulate.js'
import { resolveNetworkId } from '../../shared/validation.js'
import { channel as ChannelMethod } from '../Methods.js'

/**
 * Creates a Stellar one-way-channel method for use on the **client**.
 *
 * Instead of building a full Soroban transaction per payment, the client
 * signs an ed25519 commitment authorising the recipient to close the channel and receive up
 * to a cumulative amount from the on-chain channel contract.
 *
 * @example
 * ```ts
 * import { Keypair } from '@stellar/stellar-sdk'
 * import { Mppx } from 'mppx/client'
 * import { stellar } from '@stellar/mpp/channel/client'
 *
 * Mppx.create({
 *   methods: [
 *     stellar.channel({
 *       commitmentKey: Keypair.fromSecret('S...'),
 *     }),
 *   ],
 * })
 * ```
 */
export function channel(parameters: channel.Parameters) {
  const {
    commitmentKey: commitmentKeyParam,
    commitmentSecret,
    onProgress,
    rpcUrl,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
    store = Store.memory(),
    allowedChannels,
    allowUnpinnedChannel = false,
  } = parameters

  if (!parameters.store) {
    console.warn(
      '[stellar:channel:client] No persistent store provided — ' +
        'cumulative anti-reset protection will not survive process restarts. ' +
        'Pass a persistent Store for production use.',
    )
  }

  if (!allowedChannels || allowedChannels.length === 0) {
    if (!allowUnpinnedChannel) {
      throw new StellarMppError(
        'Channel pinning is required. Pass allowedChannels with the contract address(es) you are willing to sign for, or explicitly set allowUnpinnedChannel=true to accept the configuration tradeoff.',
      )
    }

    console.warn(
      '[stellar:channel:client] Channel pinning is disabled (allowUnpinnedChannel=true) — ' +
        'the server-selected channel may not match the one you intended to use.',
    )
  }

  if (!commitmentKeyParam && !commitmentSecret) {
    throw new StellarMppError('Either commitmentKey or commitmentSecret must be provided.')
  }

  const commitmentKey = commitmentKeyParam ?? Keypair.fromSecret(commitmentSecret!)

  return Method.toClient(ChannelMethod, {
    context: z.object({
      /** Override the cumulative amount to commit. */
      cumulativeAmount: z.optional(z.string()),
      /** Credential action: 'voucher' (default) or 'close'. */
      action: z.optional(z.enum(['voucher', 'close'])),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, channel: channelAddress } = request
      const network = resolveNetworkId(request.methodDetails?.network)

      // Enforce channel pinning: reject if the server-provided channel is not in the allowed list.
      if (allowedChannels && allowedChannels.length > 0) {
        if (!allowedChannels.includes(channelAddress)) {
          throw new StellarMppError(
            `Channel address mismatch: server advertised "${channelAddress}" ` +
              `but allowedChannels only permits: [${allowedChannels.join(', ')}]`,
          )
        }
      }

      // The server tells us the cumulative amount via methodDetails,
      // or the caller can override via context.
      const action = context?.action ?? 'voucher'

      // Read locally tracked cumulative from store (if provided).
      // The client tracks the last signed cumulative independently of the
      // server to prevent a rogue server from resetting the baseline.
      let localPrevious = 0n
      const clientCumulativeKey = `stellar:channel:client:${network}:${channelAddress}:cumulative`
      if (store) {
        const localStored = await store.get(clientCumulativeKey)
        if (localStored && typeof localStored === 'object' && 'amount' in localStored) {
          localPrevious = BigInt((localStored as { amount: string }).amount)
        }
      }

      // Take the maximum of the locally tracked baseline and the
      // server-reported value. This prevents the server from artificially
      // resetting the cumulative below what the client has already committed.
      const serverReported = BigInt(request.methodDetails?.cumulativeAmount ?? '0')
      const previousCumulative = localPrevious > serverReported ? localPrevious : serverReported

      const cumulativeAmount =
        context?.cumulativeAmount !== undefined
          ? BigInt(context.cumulativeAmount)
          : previousCumulative + BigInt(amount)

      onProgress?.({
        type: 'challenge',
        channel: channelAddress,
        amount,
        cumulativeAmount: cumulativeAmount.toString(),
      })

      // Call prepare_commitment on the channel contract (read-only)
      const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
      const networkPassphrase = NETWORK_PASSPHRASE[network]
      const server = new rpc.Server(resolvedRpcUrl)

      const contract = new Contract(channelAddress)
      const call = contract.call(
        'prepare_commitment',
        nativeToScVal(cumulativeAmount, { type: 'i128' }),
      )

      // Simulate the call to get the commitment bytes
      const account = new Account(ALL_ZEROS, '0')
      const simTx = new TransactionBuilder(account, {
        fee: DEFAULT_FEE,
        networkPassphrase,
      })
        .addOperation(call)
        .setTimeout(simulationTimeoutMs / 1000)
        .build()

      const simResult = await simulateCall(server, simTx, { timeoutMs: simulationTimeoutMs })

      // Extract the commitment bytes from the simulation result
      const returnValue = simResult.result?.retval
      if (!returnValue) {
        throw new StellarMppError('prepare_commitment returned no value')
      }

      const commitmentBytes = returnValue.bytes()

      onProgress?.({ type: 'signing' })

      // Sign the commitment bytes with the ed25519 commitment key
      const signature = commitmentKey.sign(Buffer.from(commitmentBytes))

      // Convert signature to hex string
      const sigHex = signature.toString('hex')

      // Persist the signed cumulative amount so future calls can use the
      // locally tracked baseline instead of trusting the server's claim.
      if (store) {
        await store.put(clientCumulativeKey, { amount: cumulativeAmount.toString() })
      }

      onProgress?.({
        type: 'signed',
        cumulativeAmount: cumulativeAmount.toString(),
      })

      return Credential.serialize({
        challenge,
        payload: {
          action,
          amount: cumulativeAmount.toString(),
          signature: sigHex,
        },
      })
    },
  })
}

export declare namespace channel {
  type ProgressEvent =
    | {
        type: 'challenge'
        channel: string
        amount: string
        cumulativeAmount: string
      }
    | { type: 'signing' }
    | { type: 'signed'; cumulativeAmount: string }

  type Parameters = {
    /** Ed25519 secret key (S...) for signing commitments. Provide either this or `commitmentKey`. */
    commitmentSecret?: string
    /** Stellar Keypair for signing commitments. Provide either this or `commitmentSecret`. */
    commitmentKey?: Keypair
    /** Custom Soroban RPC URL. Defaults based on network. */
    rpcUrl?: string
    /** Simulation timeout in milliseconds. @default 10_000 */
    simulationTimeoutMs?: number
    /**
     * Optional persistent store for client-side cumulative amount tracking.
     *
     * When provided, the client persists the last signed cumulative amount
     * and uses it as the baseline for subsequent commitments, taking the
     * maximum of the locally tracked value and the server-reported value.
     * This keeps the client's cumulative baseline aligned with the highest
     * value it has already signed.
     *
     * Defaults to an in-memory store — protection is active within the
     * process lifetime but does not survive restarts. Pass a persistent
     * store for production use.
     */
    store?: Store.Store
    /**
     * List of allowed channel contract addresses (C...).
     *
     * The client enforces that any channel advertised by the server in the
     * commitment challenge matches one of the addresses in this list.
     *
     * Channel pinning is required by default. To disable it, explicitly set
     * `allowUnpinnedChannel: true`.
     */
    allowedChannels?: string[]
    /**
     * Explicitly disable channel pinning.
     *
     * Unsafe: when enabled, the client will sign commitments for whatever
     * channel address the server advertises. Prefer `allowedChannels`.
     *
     * @default false
     */
    allowUnpinnedChannel?: boolean
    /** Callback invoked at each lifecycle stage. */
    onProgress?: (event: ProgressEvent) => void
  }
}
