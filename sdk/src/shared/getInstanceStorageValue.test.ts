import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getInstanceStorageValue } from './getInstanceStorageValue.js'

const mockGetLedgerEntries = vi.fn()
const rpcServer = { getLedgerEntries: mockGetLedgerEntries } as any

const CHANNEL_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 7))
const COMMITMENT_KEY = Keypair.random()
const TIMEOUT_MS = 1_000

/** Encodes a simple Soroban enum variant: `Vec([Symbol(name)])`. */
const variant = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)])

/** Builds the `getLedgerEntries` response for a contract instance holding `storage`. */
function instanceResponse(storage: [xdr.ScVal, xdr.ScVal][]) {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: storage.map(([key, val]) => new xdr.ScMapEntry({ key, val })),
  })
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(CHANNEL_ADDRESS).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(instance),
    }),
  )
  return { entries: [{ val }], latestLedger: 100 }
}

describe('getInstanceStorageValue', () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset()
  })

  it('returns CommitmentKey when it sits among unrelated entries', async () => {
    const commitmentKey = xdr.ScVal.scvBytes(COMMITMENT_KEY.rawPublicKey())
    mockGetLedgerEntries.mockResolvedValue(
      instanceResponse([
        [variant('Token'), Address.fromString(CHANNEL_ADDRESS).toScVal()],
        [variant('CloseEffectiveAtLedger'), xdr.ScVal.scvU32(42)],
        // Same name but not the enum-variant shape: must not match.
        [xdr.ScVal.scvSymbol('CommitmentKey'), xdr.ScVal.scvU32(1)],
        [variant('CommitmentKey'), commitmentKey],
        [variant('RefundWaitingPeriod'), xdr.ScVal.scvU32(10)],
      ]),
    )

    const result = await getInstanceStorageValue(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CommitmentKey',
    )

    expect(result?.toXdr('base64')).toBe(commitmentKey.toXdr('base64'))
    expect(mockGetLedgerEntries).toHaveBeenCalledOnce()
    const [ledgerKey] = mockGetLedgerEntries.mock.calls[0] as [xdr.LedgerKey]
    const contractDataKey = xdr.expectUnionVariant(ledgerKey, 'contractData').contractData
    expect(contractDataKey.key.type).toBe('scvLedgerKeyContractInstance')
  })

  it('returns null when the contract instance entry is absent', async () => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [], latestLedger: 100 })

    const result = await getInstanceStorageValue(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CommitmentKey',
    )

    expect(result).toBeNull()
  })

  it('returns null when the instance storage lacks the requested key', async () => {
    mockGetLedgerEntries.mockResolvedValue(
      instanceResponse([
        [variant('Token'), Address.fromString(CHANNEL_ADDRESS).toScVal()],
        [variant('CloseEffectiveAtLedger'), xdr.ScVal.scvU32(42)],
        [variant('RefundWaitingPeriod'), xdr.ScVal.scvU32(10)],
      ]),
    )

    const result = await getInstanceStorageValue(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CommitmentKey',
    )

    expect(result).toBeNull()

    // Same instance decodes fine: the null above came from the key lookup.
    const present = await getInstanceStorageValue(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CloseEffectiveAtLedger',
    )
    expect(present?.toXdr('base64')).toBe(xdr.ScVal.scvU32(42).toXdr('base64'))
  })
})
