import { Account, Address, Contract, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk'
import {
  ALL_ZEROS,
  DEFAULT_FEE,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
  type NetworkId,
} from '../../constants.js'
import { DEFAULT_SIM_TIMEOUT_SECS } from '../../shared/defaults.js'
import { StellarMppError } from '../../shared/errors.js'
import { scValToBigInt } from '../../shared/scval.js'

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
  const { channel: channelAddress, network = STELLAR_TESTNET, rpcUrl } = parameters

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

    const result = await server.simulateTransaction(tx)
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
  if (waitingPeriodVal.type !== 'scvU32') {
    throw new StellarMppError(
      `Expected scvU32 for refund_waiting_period, got ${waitingPeriodVal.type}`,
    )
  }
  const refundWaitingPeriod = waitingPeriodVal.value
  const token = Address.fromScVal(tokenVal!).toString()
  const from = Address.fromScVal(fromVal!).toString()
  const to = Address.fromScVal(toVal!).toString()

  // Read CloseEffectiveAtLedger from contract instance storage.
  // The contract uses DataKey::CloseEffectiveAtLedger (enum variant index 5)
  // stored in instance storage.
  const closeEffectiveAtLedger = await readCloseEffectiveAtLedger(server, channelAddress)

  const latestLedger = await server.getLatestLedger()

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
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the CloseEffectiveAtLedger entry from the contract's instance storage.
 *
 * The contract's `DataKey` enum:
 * ```rust
 * enum DataKey { Token, From, CommitmentKey, To, RefundWaitingPeriod, CloseEffectiveAtLedger }
 * ```
 * Each variant is encoded as `ScVal::Vec([ScVal::Symbol(variant_name)])` in Soroban
 * for enum variants without data.
 *
 * We look for the `CloseEffectiveAtLedger` key in the contract's instance storage.
 */
async function readCloseEffectiveAtLedger(
  server: rpc.Server,
  channelAddress: string,
): Promise<number | null> {
  // Build the LedgerKey for the contract's instance entry
  const contractId = Address.fromString(channelAddress)
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractId.toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  )

  const response = await server.getLedgerEntries(instanceKey)
  if (!response.entries || response.entries.length === 0) {
    return null
  }

  const entry = response.entries[0]
  const ledgerData = entry.val
  if (ledgerData?.type !== 'contractData') return null
  const contractData = ledgerData.contractData
  const instanceVal = contractData.val
  if (instanceVal.type !== 'scvContractInstance') return null
  const instance = instanceVal.instance
  const storage = instance.storage

  if (!storage) return null

  // Search for the CloseEffectiveAtLedger key in the instance storage map.
  // Soroban encodes simple enum variants as ScVal::Vec([ScVal::Symbol(name)])
  for (const entry of storage) {
    const key = entry.key
    // Check if this key matches DataKey::CloseEffectiveAtLedger
    if (isEnumVariant(key, 'CloseEffectiveAtLedger')) {
      const val = entry.val
      if (val.type !== 'scvU32') {
        throw new StellarMppError(`Expected scvU32 for CloseEffectiveAtLedger, got ${val.type}`)
      }
      return val.value
    }
  }

  return null
}

/** Check if an ScVal is a Soroban enum variant with the given name. */
function isEnumVariant(scVal: xdr.ScVal, name: string): boolean {
  try {
    if (scVal.type === 'scvVec') {
      const vec = scVal.value
      if (vec && vec.length === 1 && vec[0].type === 'scvSymbol') {
        return vec[0].value === name
      }
    }
  } catch {
    // not the shape we expected
  }
  return false
}
