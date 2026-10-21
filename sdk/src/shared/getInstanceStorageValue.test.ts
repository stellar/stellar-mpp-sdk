import { Address, Keypair, StrKey, xdr } from '@stellar/stellar-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getInstanceStorageEntry, getInstanceStorageValue } from './getInstanceStorageValue.js'

const mockGetLedgerEntries = vi.fn()
const rpcServer = { getLedgerEntries: mockGetLedgerEntries } as any

const CHANNEL_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 7))
const COMMITMENT_KEY = Keypair.random()
const TIMEOUT_MS = 1_000

/** Encodes a simple Soroban enum variant: `Vec([Symbol(name)])`. */
const variant = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)])

/** Builds the contract-data ledger entry stored under the channel's instance key. */
function contractDataEntry(val: xdr.ScVal) {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(CHANNEL_ADDRESS).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val,
    }),
  )
}

/** Builds the `getLedgerEntries` response for a contract instance holding `storage`. */
function instanceResponse(storage: [xdr.ScVal, xdr.ScVal][]) {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
    storage: storage.map(([key, val]) => new xdr.ScMapEntry({ key, val })),
  })
  return {
    entries: [{ val: contractDataEntry(xdr.ScVal.scvContractInstance(instance)) }],
    latestLedger: 100,
  }
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

    expect(result?.toXDR('base64')).toBe(commitmentKey.toXDR('base64'))
    expect(mockGetLedgerEntries).toHaveBeenCalledOnce()
    const [ledgerKey] = mockGetLedgerEntries.mock.calls[0] as [xdr.LedgerKey]
    expect(ledgerKey.contractData().key().switch()).toBe(
      xdr.ScValType.scvLedgerKeyContractInstance(),
    )
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
    expect(present?.u32()).toBe(42)
  })
})

describe('getInstanceStorageEntry', () => {
  beforeEach(() => {
    mockGetLedgerEntries.mockReset()
  })

  it('returns the value together with the ledger the read was served at', async () => {
    mockGetLedgerEntries.mockResolvedValue({
      ...instanceResponse([[variant('CloseEffectiveAtLedger'), xdr.ScVal.scvU32(42)]]),
      latestLedger: 4321,
    })

    const entry = await getInstanceStorageEntry(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CloseEffectiveAtLedger',
    )

    expect(entry.value?.u32()).toBe(42)
    expect(entry.latestLedger).toBe(4321)
    expect(entry.instanceFound).toBe(true)
    expect(mockGetLedgerEntries).toHaveBeenCalledOnce()
  })

  it('reports a present instance that lacks the key', async () => {
    mockGetLedgerEntries.mockResolvedValue({
      ...instanceResponse([[variant('Token'), Address.fromString(CHANNEL_ADDRESS).toScVal()]]),
      latestLedger: 4322,
    })

    const entry = await getInstanceStorageEntry(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CloseEffectiveAtLedger',
    )

    expect(entry).toEqual({ value: null, latestLedger: 4322, instanceFound: true })
  })

  it.each([{ entries: [] }, { entries: undefined }])(
    'reports a missing instance entry with the ledger: $entries',
    async ({ entries }) => {
      mockGetLedgerEntries.mockResolvedValue({ entries, latestLedger: 777 })

      const entry = await getInstanceStorageEntry(
        rpcServer,
        CHANNEL_ADDRESS,
        TIMEOUT_MS,
        'CloseEffectiveAtLedger',
      )

      expect(entry).toEqual({ value: null, latestLedger: 777, instanceFound: false })
    },
  )

  it.each([
    {
      name: 'a ledger entry that is not contract data',
      val: xdr.LedgerEntryData.ttl(
        new xdr.TtlEntry({ keyHash: Buffer.alloc(32), liveUntilLedgerSeq: 1 }),
      ),
    },
    {
      name: 'a contract data value that is not a contract instance',
      val: contractDataEntry(xdr.ScVal.scvU32(1)),
    },
    { name: 'an entry without a value', val: undefined },
  ])('reports $name as a missing instance instead of an open one', async ({ val }) => {
    mockGetLedgerEntries.mockResolvedValue({ entries: [{ val }], latestLedger: 778 })

    const entry = await getInstanceStorageEntry(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CloseEffectiveAtLedger',
    )

    expect(entry).toEqual({ value: null, latestLedger: 778, instanceFound: false })
  })

  it('reports an instance without a storage map as present without the key', async () => {
    const instance = new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
      storage: null,
    })
    mockGetLedgerEntries.mockResolvedValue({
      entries: [{ val: contractDataEntry(xdr.ScVal.scvContractInstance(instance)) }],
      latestLedger: 779,
    })

    const entry = await getInstanceStorageEntry(
      rpcServer,
      CHANNEL_ADDRESS,
      TIMEOUT_MS,
      'CloseEffectiveAtLedger',
    )

    expect(entry).toEqual({ value: null, latestLedger: 779, instanceFound: true })
  })
})
