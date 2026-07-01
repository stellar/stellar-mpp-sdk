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
import {
  ALL_ZEROS,
  DEFAULT_FEE,
  NETWORK_PASSPHRASE,
  type NetworkId,
  SOROBAN_RPC_URLS,
} from '../../constants.js'
import { DEFAULT_SIMULATION_TIMEOUT_MS } from '../../shared/defaults.js'
import { StellarMppError } from '../../shared/errors.js'
import { simulateCall } from '../../shared/simulate.js'
import { I128_MAX, resolveNetworkId, validateAmount } from '../../shared/validation.js'
import { assertCommitmentBinds } from '../commitment.js'
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
    network: pinnedNetwork,
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

      // Enforce network pinning: reject if the server-advertised network does
      // not match the one the client is configured for, so a server cannot
      // induce a signature valid on a different network than intended.
      if (pinnedNetwork && network !== pinnedNetwork) {
        throw new StellarMppError(
          `Network mismatch: server advertised "${network}" ` +
            `but this client is pinned to "${pinnedNetwork}".`,
        )
      }

      const action = context?.action ?? 'voucher'

      // The signed cumulative baseline comes solely from the client's own
      // locally tracked value. The server-reported cumulative is not
      // authoritative and is never adopted as the baseline — trusting it would
      // let a rogue server inflate the amount the client signs.
      let localPrevious = 0n
      const clientCumulativeKey = `stellar:channel:client:${network}:${channelAddress}:cumulative`
      if (store) {
        const localStored = await store.get(clientCumulativeKey)
        if (localStored && typeof localStored === 'object' && 'amount' in localStored) {
          localPrevious = BigInt((localStored as { amount: string }).amount)
        }
      }

      // Validate the numeric inputs before converting them: a malformed or
      // out-of-range value would otherwise surface as an untyped
      // SyntaxError/RangeError from BigInt/nativeToScVal rather than a typed
      // StellarMppError. `amount` is counterparty-supplied; the override is the
      // integrator's own.
      let cumulativeAmount: bigint
      if (context?.cumulativeAmount !== undefined) {
        validateAmount(context.cumulativeAmount)
        cumulativeAmount = BigInt(context.cumulativeAmount)
      } else {
        validateAmount(amount)
        cumulativeAmount = localPrevious + BigInt(amount)
      }

      // The cumulative total is encoded as a Soroban i128 below; a sum that
      // exceeds the signed i128 maximum (the locally tracked baseline plus this
      // payment) must fail as a typed error rather than throwing from nativeToScVal.
      if (cumulativeAmount > I128_MAX) {
        throw new StellarMppError(
          `Cumulative amount ${cumulativeAmount.toString()} exceeds the signed i128 maximum (${I128_MAX.toString()}).`,
        )
      }

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

      // simulateCall throws its own Simulation* error classes, which do not
      // extend StellarMppError. The triggering network/channel is
      // counterparty-influenced, so wrap the failure to keep the public client
      // API's typed-error contract.
      let simResult
      try {
        simResult = await simulateCall(server, simTx, { timeoutMs: simulationTimeoutMs })
      } catch (error) {
        if (error instanceof StellarMppError) throw error
        throw new StellarMppError(
          `Channel commitment simulation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { details: error instanceof Error ? error.message : String(error) },
        )
      }

      // Extract the commitment bytes from the simulation result
      const returnValue = simResult.result?.retval
      if (!returnValue) {
        throw new StellarMppError('prepare_commitment returned no value')
      }

      const commitmentBytes = returnValue.bytes()

      // The simulation result is not authenticated, so confirm the commitment
      // we are about to sign matches the channel, amount and network we
      // intended before signing it.
      assertCommitmentBinds(commitmentBytes, {
        channel: channelAddress,
        amount: cumulativeAmount,
        network,
      })

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
     * and uses it as the sole baseline for subsequent commitments. The
     * server-reported cumulative is never adopted as a baseline, so the value
     * the client signs always derives from what it has already signed locally.
     *
     * Defaults to an in-memory store — the baseline is tracked within the
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
     * As a second layer, the client verifies the simulated commitment matches
     * the pinned channel, the intended cumulative amount, the expected network,
     * and the channel domain separator before signing.
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
    /**
     * Network the client is pinned to (e.g. `'stellar:testnet'`).
     *
     * When set, the client rejects a commitment challenge whose advertised
     * network does not match, so a server cannot induce a signature valid on a
     * different network than intended. When omitted, the network is taken from
     * the server-advertised value.
     */
    network?: NetworkId
    /** Callback invoked at each lifecycle stage. */
    onProgress?: (event: ProgressEvent) => void
  }
}
