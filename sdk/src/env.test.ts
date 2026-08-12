import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseRequired,
  parseOptional,
  parsePort,
  parseStellarPublicKey,
  parseStellarSecretKey,
  parseContractAddress,
  parseHexKey,
  parseCommaSeparatedList,
  parseNetworkId,
  parseNumber,
} from './env.js'

describe('parseRequired', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns value when env var is set', () => {
    vi.stubEnv('TEST_VAR', 'hello')
    expect(parseRequired('TEST_VAR')).toBe('hello')
  })

  it('throws when env var is missing', () => {
    delete process.env.TEST_VAR
    expect(() => parseRequired('TEST_VAR')).toThrow('TEST_VAR is required')
  })

  it('throws when env var is empty string', () => {
    vi.stubEnv('TEST_VAR', '')
    expect(() => parseRequired('TEST_VAR')).toThrow('TEST_VAR is required')
  })
})

describe('parseOptional', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns value when set', () => {
    vi.stubEnv('TEST_VAR', 'hello')
    expect(parseOptional('TEST_VAR')).toBe('hello')
  })

  it('returns undefined when missing', () => {
    delete process.env.TEST_VAR
    expect(parseOptional('TEST_VAR')).toBeUndefined()
  })

  it('returns fallback when missing', () => {
    delete process.env.TEST_VAR
    expect(parseOptional('TEST_VAR', 'default')).toBe('default')
  })
})

describe('parsePort', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns default port when env var missing', () => {
    delete process.env.PORT
    expect(parsePort('PORT', 3000)).toBe(3000)
  })

  it('reads PORT from env', () => {
    vi.stubEnv('PORT', '8080')
    expect(parsePort('PORT', 3000)).toBe(8080)
  })

  it('throws on non-integer', () => {
    vi.stubEnv('PORT', 'abc')
    expect(() => parsePort('PORT', 3000)).toThrow('Invalid PORT')
  })

  it('throws on out-of-range port', () => {
    vi.stubEnv('PORT', '99999')
    expect(() => parsePort('PORT', 3000)).toThrow('Invalid PORT')
  })
})

describe('parseStellarPublicKey', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns valid G... key', () => {
    const key = 'GATLN2B5WYM6PV64X532ZNQ6Q22HVNFNOTH27VLYEHYLRLM5KNBWV2PL'
    vi.stubEnv('RECIPIENT', key)
    expect(parseStellarPublicKey('RECIPIENT')).toBe(key)
  })

  it('throws when missing', () => {
    delete process.env.RECIPIENT
    expect(() => parseStellarPublicKey('RECIPIENT')).toThrow('RECIPIENT is required')
  })

  it('throws on invalid format', () => {
    vi.stubEnv('RECIPIENT', 'SNOTAPUBLICKEY')
    expect(() => parseStellarPublicKey('RECIPIENT')).toThrow(
      'must be a valid Stellar public key (G...)',
    )
  })

  it('throws on wrong length', () => {
    vi.stubEnv('RECIPIENT', 'GSHORT')
    expect(() => parseStellarPublicKey('RECIPIENT')).toThrow(
      'must be a valid Stellar public key (G...)',
    )
  })

  it('throws on invalid checksum', () => {
    // Valid prefix and length but corrupted checksum (last char changed)
    vi.stubEnv('RECIPIENT', 'GATLN2B5WYM6PV64X532ZNQ6Q22HVNFNOTH27VLYEHYLRLM5KNBWV2PA')
    expect(() => parseStellarPublicKey('RECIPIENT')).toThrow(
      'must be a valid Stellar public key (G...)',
    )
  })
})

describe('parseStellarSecretKey', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns valid S... key', () => {
    const key = 'SA5KKLVMJWQNZU4I2PIT2DYLPR6VBB552EQGRZB2EKMPCYICGWH56YXP'
    vi.stubEnv('SECRET', key)
    expect(parseStellarSecretKey('SECRET')).toBe(key)
  })

  it('throws on invalid format', () => {
    vi.stubEnv('SECRET', 'GNOTASECRETKEY')
    expect(() => parseStellarSecretKey('SECRET')).toThrow(
      'must be a valid Stellar secret key (S...)',
    )
  })

  it('throws on invalid checksum', () => {
    vi.stubEnv('SECRET', 'SA5KKLVMJWQNZU4I2PIT2DYLPR6VBB552EQGRZB2EKMPCYICGWH56YXA')
    expect(() => parseStellarSecretKey('SECRET')).toThrow(
      'must be a valid Stellar secret key (S...)',
    )
  })
})

describe('parseContractAddress', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns valid C... address', () => {
    const addr = 'CBU3P5BAU6CYGPAVY7TGGGNEPCS7H73IA3L677Z3CFZSGFYB7UFK4IMS'
    vi.stubEnv('CONTRACT', addr)
    expect(parseContractAddress('CONTRACT')).toBe(addr)
  })

  it('throws on invalid format', () => {
    vi.stubEnv('CONTRACT', 'GNOTACONTRACT')
    expect(() => parseContractAddress('CONTRACT')).toThrow(
      'must be a valid contract address (C...)',
    )
  })

  it('throws on invalid checksum', () => {
    vi.stubEnv('CONTRACT', 'CBU3P5BAU6CYGPAVY7TGGGNEPCS7H73IA3L677Z3CFZSGFYB7UFK4IMA')
    expect(() => parseContractAddress('CONTRACT')).toThrow(
      'must be a valid contract address (C...)',
    )
  })
})

describe('parseNetworkId', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the configured network identifier', () => {
    vi.stubEnv('STELLAR_NETWORK', 'stellar:pubnet')
    expect(parseNetworkId()).toBe('stellar:pubnet')
  })

  it('defaults to testnet when unset', () => {
    delete process.env.STELLAR_NETWORK
    expect(parseNetworkId()).toBe('stellar:testnet')
  })

  it('reads the named env var', () => {
    vi.stubEnv('CLIENT_NETWORK', 'stellar:pubnet')
    expect(parseNetworkId('CLIENT_NETWORK')).toBe('stellar:pubnet')
  })

  it('throws on an unsupported network identifier', () => {
    vi.stubEnv('STELLAR_NETWORK', 'stellar:futurenet')
    expect(() => parseNetworkId()).toThrow('Unsupported Stellar network identifier')
  })
})

describe('parseHexKey', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns valid 64-char hex key', () => {
    const hex = 'b83ee77019d9ca0aac432139fe0159ec01b5d31f58905fdc089980be05b7c5fd'
    vi.stubEnv('HEX_KEY', hex)
    expect(parseHexKey('HEX_KEY')).toBe(hex)
  })

  it('throws on wrong length', () => {
    vi.stubEnv('HEX_KEY', 'abcd')
    expect(() => parseHexKey('HEX_KEY')).toThrow('must be 64 hex characters')
  })

  it('throws on non-hex characters', () => {
    vi.stubEnv('HEX_KEY', 'zzzz' + '0'.repeat(60))
    expect(() => parseHexKey('HEX_KEY')).toThrow('must be 64 hex characters')
  })

  it('accepts custom length', () => {
    vi.stubEnv('SHORT_KEY', 'abcd1234')
    expect(parseHexKey('SHORT_KEY', 8)).toBe('abcd1234')
  })
})

describe('parseCommaSeparatedList', () => {
  it('splits comma-separated values', () => {
    expect(parseCommaSeparatedList('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('trims whitespace', () => {
    expect(parseCommaSeparatedList(' a , b , c ')).toEqual(['a', 'b', 'c'])
  })

  it('filters empty entries', () => {
    expect(parseCommaSeparatedList('a,,b,')).toEqual(['a', 'b'])
  })

  it('returns empty array for empty string', () => {
    expect(parseCommaSeparatedList('')).toEqual([])
  })
})

describe('parseNumber', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns value from env', () => {
    vi.stubEnv('NUM', '42')
    expect(parseNumber('NUM')).toBe(42)
  })

  it('returns fallback when missing', () => {
    delete process.env.NUM
    expect(parseNumber('NUM', { fallback: 10 })).toBe(10)
  })

  it('throws when missing with no fallback', () => {
    delete process.env.NUM
    expect(() => parseNumber('NUM')).toThrow('NUM is required')
  })

  it('throws on non-number', () => {
    vi.stubEnv('NUM', 'abc')
    expect(() => parseNumber('NUM')).toThrow('Invalid NUM')
  })

  it('validates min', () => {
    vi.stubEnv('NUM', '0')
    expect(() => parseNumber('NUM', { min: 1 })).toThrow('NUM must be >= 1')
  })

  it('validates max', () => {
    vi.stubEnv('NUM', '100')
    expect(() => parseNumber('NUM', { max: 50 })).toThrow('NUM must be <= 50')
  })
})
