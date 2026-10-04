import { Address, rpc, xdr } from '@stellar/stellar-sdk'

import { withTimeout } from './timeout.js'

/**
 * Returns the value of the key specified from the contract's DataKey in the instance storage.
 *
 * @param server - The RPC server instance to query.
 * @param channelAddress - The address of the channel contract.
 * @param simulationTimeoutMs - Timeout for the simulation in milliseconds.
 * @param key - The name of the key to retrieve from the instance storage.
 * @returns ScVal or null if not found.
 */

export async function getStorageKey(
  server: rpc.Server,
  channelAddress: string,
  simulationTimeoutMs: number,
  key: string,
): Promise<xdr.ScVal | null> {
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
  if (!response.entries || response.entries.length === 0) {
    return null
  }

  const entry = response.entries[0]
  const ledgerData = entry.val
  const contractData = ledgerData?.contractData?.()
  if (!contractData) return null
  const instance = contractData.val?.()?.instance?.()
  if (!instance) return null
  const storage = instance.storage()

  if (!storage) return null

  // Search for the requested DataKey variant in the instance storage map.
  // Soroban encodes simple enum variants as ScVal::Vec([ScVal::Symbol(name)])
  for (const entry of storage) {
    const entryKey = entry.key()
    if (isEnumVariant(entryKey, key)) {
      const val = entry.val()
      return val
    }
  }

  return null
}

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
