import { Address, rpc, xdr } from '@stellar/stellar-sdk'

import { withTimeout } from './timeout.js'

/** A value read from a contract's instance storage and the ledger the read was served at. */
export type InstanceStorageEntry = {
  /** The stored value, or null when the key is absent. */
  value: xdr.ScVal | null
  /** Latest ledger sequence at the time of the read, as reported by the RPC server. */
  latestLedger: number
  /**
   * Whether a readable contract instance entry was found. False when no entry
   * comes back (archived contract, wrong address) and when the entry is not a
   * contract instance, which a caller may need to tell apart from an instance
   * that merely lacks the key.
   */
  instanceFound: boolean
}

/**
 * Reads the value stored under the given DataKey in the contract's instance
 * storage, together with the ledger the read was served at, so callers can
 * date the value they observed.
 *
 * @param server - The RPC server instance to query.
 * @param channelAddress - The address of the channel contract.
 * @param simulationTimeoutMs - Timeout for the read in milliseconds.
 * @param key - The name of the key to retrieve from the instance storage.
 * @returns The value (or null if not found), whether the instance entry exists,
 *   and the RPC server's latest ledger.
 */
export async function getInstanceStorageEntry(
  server: rpc.Server,
  channelAddress: string,
  simulationTimeoutMs: number,
  key: string,
): Promise<InstanceStorageEntry> {
  const contractId = Address.fromString(channelAddress)
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractId.toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  )

  const response = await withTimeout(
    server.getLedgerEntries(instanceKey),
    simulationTimeoutMs,
    `getLedgerEntries for channel ${channelAddress}`,
  )
  const latestLedger = response.latestLedger
  const notFound: InstanceStorageEntry = { value: null, latestLedger, instanceFound: false }
  if (!response.entries || response.entries.length === 0) return notFound

  // An entry that is not a contract instance cannot be read as one, so it is
  // reported as not found rather than as an instance that lacks the key.
  const ledgerData = response.entries[0].val
  if (ledgerData?.switch().value !== xdr.LedgerEntryType.contractData().value) return notFound
  const stored = ledgerData.contractData().val()
  if (stored.switch().value !== xdr.ScValType.scvContractInstance().value) return notFound
  const instanceStorage = stored.instance().storage()

  // An instance may have no storage map at all: it exists, but holds no key.
  if (!instanceStorage) return { value: null, latestLedger, instanceFound: true }

  // Search for the requested DataKey variant in the instance storage map.
  // Soroban encodes simple enum variants as ScVal::Vec([ScVal::Symbol(name)])
  for (const item of instanceStorage) {
    if (isEnumVariant(item.key(), key)) {
      return { value: item.val(), latestLedger, instanceFound: true }
    }
  }

  return { value: null, latestLedger, instanceFound: true }
}

/**
 * Returns the value of the key specified from the contract's DataKey in the instance storage.
 *
 * @param server - The RPC server instance to query.
 * @param channelAddress - The address of the channel contract.
 * @param simulationTimeoutMs - Timeout for the simulation in milliseconds.
 * @param key - The name of the key to retrieve from the instance storage.
 * @returns ScVal or null if not found.
 */
export async function getInstanceStorageValue(
  server: rpc.Server,
  channelAddress: string,
  simulationTimeoutMs: number,
  key: string,
): Promise<xdr.ScVal | null> {
  const { value } = await getInstanceStorageEntry(server, channelAddress, simulationTimeoutMs, key)
  return value
}

/**
 * Checks whether an ScVal encodes the named simple enum variant.
 *
 * Soroban encodes a simple enum variant as a vector containing one symbol,
 * such as `Vec([Symbol("KeyName")])`. Returns false for other shapes or if
 * decoding the ScVal fails.
 *
 * @param scVal - The ScVal to inspect.
 * @param name - The expected enum variant name.
 * @returns Whether the ScVal encodes the named variant.
 */
function isEnumVariant(scVal: xdr.ScVal, name: string): boolean {
  try {
    if (scVal.switch().value === xdr.ScValType.scvVec().value) {
      const vec = scVal.vec()!
      if (vec.length === 1 && vec[0].switch().value === xdr.ScValType.scvSymbol().value) {
        return vec[0].sym().toString() === name
      }
    }
  } catch {
    // not the shape we expected
  }
  return false
}
