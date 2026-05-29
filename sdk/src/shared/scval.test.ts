import { describe, expect, it } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'
import { scValToBigInt } from './scval.js'

describe('scValToBigInt', () => {
  it('converts scvU32', () => {
    const val = xdr.ScVal.scvU32(42)
    expect(scValToBigInt(val)).toBe(42n)
  })

  it('converts scvI32', () => {
    const val = xdr.ScVal.scvI32(-7)
    expect(scValToBigInt(val)).toBe(-7n)
  })

  it('converts scvU64', () => {
    const val = xdr.ScVal.scvU64(1_000_000n)
    expect(scValToBigInt(val)).toBe(1_000_000n)
  })

  it('converts scvI64', () => {
    const val = xdr.ScVal.scvI64(-500n)
    expect(scValToBigInt(val)).toBe(-500n)
  })

  it('converts scvU128', () => {
    const val = xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 1n, lo: 1n }))
    expect(scValToBigInt(val)).toBe((1n << 64n) | 1n)
  })

  it('converts scvI128 with hi=0', () => {
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 99n }))
    expect(scValToBigInt(val)).toBe(99n)
  })

  it('converts scvI128 with non-zero hi (large SAC amounts)', () => {
    // Verifies hi << 64 | lo is computed correctly for large token amounts.
    // Before the fix, inconsistent implementations could produce wrong results.
    const val = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 1n, lo: 99n }))
    // 1 * 2^64 + 99
    expect(scValToBigInt(val)).toBe((1n << 64n) + 99n)
  })

  it('converts scvU128 with non-zero hi (large amounts)', () => {
    // Verifies u128 with significant hi bits also decodes correctly
    const val = xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 2n, lo: 0n }))
    expect(scValToBigInt(val)).toBe(2n << 64n)
  })

  it('converts scvU128 zero', () => {
    const val = xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo: 0n }))
    expect(scValToBigInt(val)).toBe(0n)
  })

  it('throws for unsupported ScVal type', () => {
    const val = xdr.ScVal.scvBool(true)
    expect(() => scValToBigInt(val)).toThrow('Cannot convert ScVal type')
  })
})
