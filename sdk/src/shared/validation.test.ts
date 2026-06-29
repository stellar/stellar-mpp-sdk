import { describe, it, expect } from 'vitest'
import { validateHexSignature, validateAmount, resolveNetworkId } from './validation.js'
import { StellarMppError } from './errors.js'

describe('validateHexSignature', () => {
  it('accepts valid 128-char hex signature', () => {
    const sig = 'a'.repeat(128)
    expect(() => validateHexSignature(sig)).not.toThrow()
  })

  it('throws on wrong length', () => {
    expect(() => validateHexSignature('abcd')).toThrow()
  })

  it('throws on non-hex characters', () => {
    expect(() => validateHexSignature('z'.repeat(128))).toThrow()
  })

  it('throws on odd-length hex', () => {
    expect(() => validateHexSignature('a'.repeat(127))).toThrow()
  })

  it('accepts custom expected length', () => {
    expect(() => validateHexSignature('abcd1234', 8)).not.toThrow()
  })
})

describe('resolveNetworkId', () => {
  it('returns stellar:testnet when network is null', () => {
    expect(resolveNetworkId(null)).toBe('stellar:testnet')
  })

  it('returns stellar:testnet when network is undefined', () => {
    expect(resolveNetworkId(undefined)).toBe('stellar:testnet')
  })

  it('accepts stellar:testnet', () => {
    expect(resolveNetworkId('stellar:testnet')).toBe('stellar:testnet')
  })

  it('accepts stellar:pubnet', () => {
    expect(resolveNetworkId('stellar:pubnet')).toBe('stellar:pubnet')
  })

  it('throws on unsupported network with list of supported networks', () => {
    expect(() => resolveNetworkId('stellar:futurenet')).toThrow(
      'Unsupported Stellar network identifier: "stellar:futurenet". Supported networks: stellar:pubnet, stellar:testnet',
    )
  })

  it('throws on old-style network identifiers', () => {
    expect(() => resolveNetworkId('testnet')).toThrow('Unsupported Stellar network identifier')
    expect(() => resolveNetworkId('public')).toThrow('Unsupported Stellar network identifier')
  })

  it('throws on non-string values', () => {
    expect(() => resolveNetworkId(42)).toThrow('Unsupported Stellar network identifier')
  })
})

describe('validateAmount', () => {
  it('accepts valid BigInt string', () => {
    expect(() => validateAmount('1000000')).not.toThrow()
  })

  it('rejects zero', () => {
    expect(() => validateAmount('0')).toThrow()
  })

  it('rejects leading zeros', () => {
    expect(() => validateAmount('01')).toThrow()
    expect(() => validateAmount('007')).toThrow()
  })

  it('throws on non-numeric string', () => {
    expect(() => validateAmount('abc')).toThrow()
  })

  it('throws on negative', () => {
    expect(() => validateAmount('-100')).toThrow()
  })

  it('throws on empty string', () => {
    expect(() => validateAmount('')).toThrow()
  })

  it('throws on decimal', () => {
    expect(() => validateAmount('1.5')).toThrow()
  })

  it('accepts the maximum signed i128 value', () => {
    expect(() => validateAmount((2n ** 127n - 1n).toString())).not.toThrow()
  })

  it('throws StellarMppError on a value exceeding the signed i128 maximum', () => {
    expect(() => validateAmount((2n ** 127n).toString())).toThrow(StellarMppError)
    expect(() => validateAmount((2n ** 127n).toString())).toThrow(/i128 maximum/)
  })
})
