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
import { ChannelVerificationError, StellarMppError } from '../../shared/errors.js'
import { scValToBigInt } from '../../shared/scval.js'
import { withTimeout } from '../../shared/timeout.js'
import { getInstanceStorageEntry } from '../../shared/getInstanceStorageValue.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelState = {
  /** Current token balance held in the channel contract. */
  balance: bigint
  /**
   * Total amount the recipient has already withdrawn via `settle` or `close`.
   * A close with a stored commitment is complete once this reaches its amount.
   */
  withdrawn: bigint
  /**
   * Total amount deposited into the channel (`balance + withdrawn`), read from
   * the contract's `deposited()` in one call so a settle landing between the
   * separate `balance` and `withdrawn` reads cannot overstate it.
   */
  deposited: bigint
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
  /** Ledger sequence `closeEffectiveAtLedger` was read at. */
  closeStatusLedger: number
  /**
   * Latest ledger sequence, read before the close status, so
   * `closeStatusLedger` is normally at or after it.
   */
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
 * Getter simulation failures propagate before the instance-storage read.
 *
 * @throws {ChannelVerificationError} If the instance entry is missing when read.
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
    const retval = result.result?.retval
    if (!retval) {
      throw new StellarMppError(
        `Failed to simulate ${fnName} on channel ${channelAddress}: missing return value`,
      )
    }
    return retval
  }

  // Run getter simulations in parallel. Each simulation is its own ledger
  // read, so `deposited` comes from the contract's getter rather than from
  // `balance + withdrawn`: a settle landing between those two reads would
  // otherwise overstate the deposit.
  const [balanceVal, waitingPeriodVal, tokenVal, fromVal, toVal, withdrawnVal, depositedVal] =
    await Promise.all([
      simulateGetter('balance'),
      simulateGetter('refund_waiting_period'),
      simulateGetter('token'),
      simulateGetter('from'),
      simulateGetter('to'),
      simulateGetter('withdrawn'),
      simulateGetter('deposited'),
    ])

  const balance = scValToBigInt(balanceVal)
  const withdrawn = scValToBigInt(withdrawnVal)
  const deposited = scValToBigInt(depositedVal)
  const refundWaitingPeriod = waitingPeriodVal.u32()
  const token = Address.fromScVal(tokenVal).toString()
  const from = Address.fromScVal(fromVal).toString()
  const to = Address.fromScVal(toVal).toString()

  // Read the latest ledger before the close status, so the status covers it
  // even when a ledger closes between the two reads.
  const latestLedger = await withTimeout(
    server.getLatestLedger(),
    simulationTimeoutMs,
    `getLatestLedger for channel ${channelAddress}`,
  )

  // Read CloseEffectiveAtLedger from contract instance storage, together with
  // the ledger that read was served at, so the close status carries its date.
  // An existing instance without that key is open; a missing instance cannot
  // be treated as open because it may be archived or the address may be wrong.
  const closeEntry = await getInstanceStorageEntry(
    server,
    channelAddress,
    simulationTimeoutMs,
    'CloseEffectiveAtLedger',
  )
  if (!closeEntry.instanceFound) {
    throw new ChannelVerificationError(
      '[stellar:channel] Channel instance entry not found on-chain (archived or wrong address).',
      { channel: channelAddress },
    )
  }
  const closeEffectiveAtLedger = closeEntry.value ? closeEntry.value.u32() : null
  const closeStatusLedger = closeEntry.latestLedger

  return {
    balance,
    withdrawn,
    deposited,
    refundWaitingPeriod,
    token,
    from,
    to,
    closeEffectiveAtLedger,
    closeStatusLedger,
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
