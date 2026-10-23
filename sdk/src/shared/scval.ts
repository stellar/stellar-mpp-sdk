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
    case 'scvU32':
      return BigInt(val.u32)
    case 'scvI32':
      return BigInt(val.i32)
    case 'scvU64':
      return val.u64
    case 'scvI64':
      return val.i64
    case 'scvU128': {
      const hi = val.u128.hi
      const lo = val.u128.lo & 0xffffffffffffffffn
      return (hi << 64n) | lo
    }
    case 'scvI128': {
      const hi = val.i128.hi
      const lo = val.i128.lo & 0xffffffffffffffffn
      return (hi << 64n) | lo
    }
    default:
      throw new StellarMppError(`Cannot convert ScVal type ${val.type} to BigInt`)
  }
}
