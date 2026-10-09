import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it, vi } from 'vitest'

// Hoisted mock stubs
const mockGetAccount = vi.fn()
const mockSimulateTransaction = vi.fn()
const mockGetLedgerEntries = vi.fn()
const mockGetLatestLedger = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getAccount = mockGetAccount
        this.simulateTransaction = mockSimulateTransaction
        this.getLedgerEntries = mockGetLedgerEntries
        this.getLatestLedger = mockGetLatestLedger
      }),
    },
  }
})

const { getChannelState } = await import('./State.js')

const SOURCE_ACCOUNT = Keypair.random().publicKey()
const CHANNEL_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
const TOKEN_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const FUNDER_ADDRESS = Keypair.random().publicKey()
const RECIPIENT_ADDRESS = Keypair.random().publicKey()

// Default account stub
mockGetAccount.mockResolvedValue({
  accountId: () => SOURCE_ACCOUNT,
  sequenceNumber: () => '0',
  sequence: () => '0',
  incrementSequenceNumber: () => {},
})

function makeI128ScVal(amount: bigint): xdr.ScVal {
  const lo = amount & 0xffffffffffffffffn
  const hi = amount >> 64n
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString(lo.toString()),
      hi: xdr.Int64.fromString(hi.toString()),
    }),
  )
}

function makeAddressScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal()
}

function setupSimulations(opts: {
  balance: bigint
  waitingPeriod: number
  token: string
  from: string
  to: string
  withdrawn?: bigint
}) {
  const calls: xdr.ScVal[] = [
    makeI128ScVal(opts.balance),
    xdr.ScVal.scvU32(opts.waitingPeriod),
    makeAddressScVal(opts.token),
    makeAddressScVal(opts.from),
    makeAddressScVal(opts.to),
    makeI128ScVal(opts.withdrawn ?? 0n),
  ]

  let callIndex = 0
  mockSimulateTransaction.mockImplementation(() => ({
    result: { retval: calls[callIndex++] },
    transactionData: 'mock',
  }))
}

function makeLedgerEntryWithCloseEffective(ledgerValue: number) {
  // Build instance storage with CloseEffectiveAtLedger
  const storage = [
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('CloseEffectiveAtLedger')]),
      val: xdr.ScVal.scvU32(ledgerValue),
    }),
  ]

  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
    storage,
  })

  const contractData = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4, 0), 'raw'),
    contract: Address.fromString(CHANNEL_ADDRESS).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  })

  const entryData = xdr.LedgerEntryData.contractData(contractData)

  return { entries: [{ val: entryData, lastModifiedLedgerSeq: 100 }] }
}

function makeLedgerEntryWithoutCloseEffective() {
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
    storage: [],
  })

  const contractData = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.fromXDR(Buffer.alloc(4, 0), 'raw'),
    contract: Address.fromString(CHANNEL_ADDRESS).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(instance),
  })

  const entryData = xdr.LedgerEntryData.contractData(contractData)

  return { entries: [{ val: entryData, lastModifiedLedgerSeq: 100 }] }
}

describe('getChannelState', () => {
  it('returns channel state from on-chain getters', async () => {
    setupSimulations({
      balance: 10_000_000n,
      waitingPeriod: 1000,
      token: TOKEN_ADDRESS,
      from: FUNDER_ADDRESS,
      to: RECIPIENT_ADDRESS,
      withdrawn: 2_500_000n,
    })
    mockGetLedgerEntries.mockResolvedValueOnce({
      ...makeLedgerEntryWithoutCloseEffective(),
      latestLedger: 5001,
    })
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 5000 })

    const state = await getChannelState({
      channel: CHANNEL_ADDRESS,
    })

    expect(state.balance).toBe(10_000_000n)
    expect(state.withdrawn).toBe(2_500_000n)
    expect(state.deposited).toBe(12_500_000n)
    expect(state.refundWaitingPeriod).toBe(1000)
    expect(state.token).toBe(TOKEN_ADDRESS)
    expect(state.from).toBe(FUNDER_ADDRESS)
    expect(state.to).toBe(RECIPIENT_ADDRESS)
    expect(state.closeEffectiveAtLedger).toBeNull()
    expect(state.closeStatusLedger).toBe(5001)
    expect(state.currentLedger).toBe(5000)
    // The close status is read after the latest ledger, so it covers it.
    expect(mockGetLatestLedger.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockGetLedgerEntries.mock.invocationCallOrder.at(-1)!,
    )
  })

  it('detects close_start via CloseEffectiveAtLedger in instance storage', async () => {
    setupSimulations({
      balance: 5_000_000n,
      waitingPeriod: 1000,
      token: TOKEN_ADDRESS,
      from: FUNDER_ADDRESS,
      to: RECIPIENT_ADDRESS,
    })
    mockGetLedgerEntries.mockResolvedValueOnce({
      ...makeLedgerEntryWithCloseEffective(6000),
      latestLedger: 5500,
    })
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 5500 })

    const state = await getChannelState({
      channel: CHANNEL_ADDRESS,
    })

    expect(state.closeEffectiveAtLedger).toBe(6000)
    expect(state.closeStatusLedger).toBe(5500)
    expect(state.currentLedger).toBe(5500)
    // Nothing withdrawn yet: the whole deposit is still in the channel.
    expect(state.withdrawn).toBe(0n)
    expect(state.deposited).toBe(5_000_000n)
  })

  it('returns null closeEffectiveAtLedger when no entries', async () => {
    setupSimulations({
      balance: 1_000_000n,
      waitingPeriod: 500,
      token: TOKEN_ADDRESS,
      from: FUNDER_ADDRESS,
      to: RECIPIENT_ADDRESS,
    })
    mockGetLedgerEntries.mockResolvedValueOnce({ entries: [], latestLedger: 1000 })
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 1000 })

    const state = await getChannelState({
      channel: CHANNEL_ADDRESS,
    })

    expect(state.closeEffectiveAtLedger).toBeNull()
    expect(state.closeStatusLedger).toBe(1000)
  })

  it('throws on simulation failure', async () => {
    mockSimulateTransaction.mockResolvedValue({
      error: 'simulation failed',
    })

    await expect(
      getChannelState({
        channel: CHANNEL_ADDRESS,
      }),
    ).rejects.toThrow('Failed to simulate')
  })

  it('rejects when an RPC call hangs past the simulation timeout', async () => {
    vi.useFakeTimers()
    try {
      // A hung RPC never settles; without a JS-level timeout getChannelState would
      // stall indefinitely, holding the per-channel verification lock.
      mockSimulateTransaction.mockImplementation(() => new Promise(() => {}))
      mockGetLedgerEntries.mockResolvedValue(makeLedgerEntryWithoutCloseEffective())
      mockGetLatestLedger.mockResolvedValue({ sequence: 5000 })

      const statePromise = getChannelState({
        channel: CHANNEL_ADDRESS,
        simulationTimeoutMs: 1000,
      })
      const assertion = expect(statePromise).rejects.toThrow(/timed out/i)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
