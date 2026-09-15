import { Account, Address, Contract, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk'
import {
  ALL_ZEROS,
  DEFAULT_FEE,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
  type NetworkId,
} from '../../constants.js'
import { DEFAULT_SIM_TIMEOUT_SECS, DEFAULT_SIMULATION_TIMEOUT_MS } from '../../shared/defaults.js'
import { StellarMppError } from '../../shared/errors.js'
import { scValToBigInt } from '../../shared/scval.js'
import { withTimeout } from '../../shared/timeout.js'
import { getStorageKey } from '../../shared/getStorageKey.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelState = {
  /** Current token balance held in the channel contract. */
  balance: bigint
  /** The refund waiting period in ledgers. */
  refundWaitingPeriod: number
  /** Token contract address. */
  token: string
  /** Funder address. */
  from: string
  /** Recipient address. */
  to: string
  /**
   * If set, the ledger sequence at which close becomes effective. This means
   * either `close_start` has been called (dispute) or `close` has settled.
   * If the current ledger is past this value, the funder can call `refund`.
   */
  closeEffectiveAtLedger: number | null
  /** Current ledger sequence at the time of the query. */
  currentLedger: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Query the on-chain state of a one-way payment channel contract.
 *
 * This calls the contract's public getter functions via simulation
 * (no transaction fees) and reads instance storage for dispute status.
 *
 * @example
 * ```ts
 * import { getChannelState } from '@stellar/mpp/channel/server'
 *
 * const state = await getChannelState({
 *   channel: 'CABC...',
 * })
 *
 * if (state.closeEffectiveAtLedger != null) {
 *   console.log('Channel is closing/closed!')
 * }
 * ```
 */
export async function getChannelState(
  parameters: getChannelState.Parameters,
): Promise<ChannelState> {
  const {
    channel: channelAddress,
    network = STELLAR_TESTNET,
    rpcUrl,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
  } = parameters

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const networkPassphrase = NETWORK_PASSPHRASE[network]
  const server = new rpc.Server(resolvedRpcUrl)

  const contract = new Contract(channelAddress)
  const account = new Account(ALL_ZEROS, '0')

  async function simulateGetter(fnName: string, ...args: xdr.ScVal[]) {
    const call = contract.call(fnName, ...args)
    const tx = new TransactionBuilder(account, {
      fee: DEFAULT_FEE,
      networkPassphrase,
    })
      .addOperation(call)
      .setTimeout(DEFAULT_SIM_TIMEOUT_SECS)
      .build()

    const result = await withTimeout(
      server.simulateTransaction(tx),
      simulationTimeoutMs,
      `simulate ${fnName} on channel ${channelAddress}`,
    )
    if (!rpc.Api.isSimulationSuccess(result)) {
      const errorMsg = 'error' in result ? String(result.error) : 'unknown'
      throw new StellarMppError(
        `Failed to simulate ${fnName} on channel ${channelAddress}: ${errorMsg}`,
      )
    }
    return result.result?.retval
  }

  // Run getter simulations in parallel
  const [balanceVal, waitingPeriodVal, tokenVal, fromVal, toVal] = await Promise.all([
    simulateGetter('balance'),
    simulateGetter('refund_waiting_period'),
    simulateGetter('token'),
    simulateGetter('from'),
    simulateGetter('to'),
  ])

  const balance = scValToBigInt(balanceVal!)
  if (!waitingPeriodVal) {
    throw new StellarMppError(
      `Failed to simulate refund_waiting_period on channel ${channelAddress}: missing return value`,
    )
  }
  const refundWaitingPeriod = waitingPeriodVal.u32()
  const token = Address.fromScVal(tokenVal!).toString()
  const from = Address.fromScVal(fromVal!).toString()
  const to = Address.fromScVal(toVal!).toString()

  // Read CloseEffectiveAtLedger from contract instance storage.
  // The contract uses DataKey::CloseEffectiveAtLedger (enum variant index 5)
  // stored in instance storage.
  const closeEntry = await getStorageKey(
    server,
    channelAddress,
    simulationTimeoutMs,
    'CloseEffectiveAtLedger',
  )

  const closeEffectiveAtLedger = closeEntry ? closeEntry.u32() : null

  const latestLedger = await withTimeout(
    server.getLatestLedger(),
    simulationTimeoutMs,
    `getLatestLedger for channel ${channelAddress}`,
  )

  return {
    balance,
    refundWaitingPeriod,
    token,
    from,
    to,
    closeEffectiveAtLedger,
    currentLedger: latestLedger.sequence,
  }
}

export declare namespace getChannelState {
  type Parameters = {
    /** Channel contract address (C...). */
    channel: string
    /** Stellar network. @default 'stellar:testnet' */
    network?: NetworkId
    /** Custom Soroban RPC URL. */
    rpcUrl?: string
    /**
     * Per-RPC timeout in milliseconds. Each on-chain getter, the instance-storage
     * read, and the latest-ledger query is bounded by this so a hung RPC cannot
     * stall the caller indefinitely. @default 10000
     */
    simulationTimeoutMs?: number
  }
}
