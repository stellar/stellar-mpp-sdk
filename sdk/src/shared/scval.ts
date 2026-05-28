import { xdr } from '@stellar/stellar-sdk'
import { StellarMppError } from './errors.js'

/**
 * Convert a Soroban ScVal to a BigInt.
 *
 * Handles u32, i32, u64, i64, u128, and i128 types. The lo limb is
 * masked to 64 bits so that unsigned Uint64 values are treated correctly
 * regardless of the host representation.
 */
export function scValToBigInt(val: xdr.ScVal): bigint {
  switch (val.type) {
    // scvU32 = 3
    case 'scvU32':
      return BigInt(val.value)
    // scvI32 = 4
    case 'scvI32':
      return BigInt(val.value)
    // scvU64 = 5
    case 'scvU64':
      return val.value
    // scvI64 = 6
    case 'scvI64':
      return val.value
    // scvU128 = 9
    case 'scvU128': {
      const parts = val.value
      const hi = parts.hi
      const lo = parts.lo & 0xffffffffffffffffn
      return (hi << 64n) | lo
    }
    // scvI128 = 10
    case 'scvI128': {
      const parts = val.value
      const hi = parts.hi
      const lo = parts.lo & 0xffffffffffffffffn
      return (hi << 64n) | lo
    }
    default:
      throw new StellarMppError(`Cannot convert ScVal type ${val.type} to BigInt`)
  }
}
