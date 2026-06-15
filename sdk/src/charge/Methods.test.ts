import { describe, expect, it } from 'vitest'
import { Method } from 'mppx'
import * as Methods from './Methods.js'
import { toBaseUnits, fromBaseUnits } from './Methods.js'

// ---------------------------------------------------------------------------
// Amount helpers
// ---------------------------------------------------------------------------

describe('toBaseUnits', () => {
  it('converts whole number', () => {
    expect(toBaseUnits('1', 7)).toBe('10000000')
  })

  it('converts decimal', () => {
    expect(toBaseUnits('0.01', 7)).toBe('100000')
  })

  it('converts zero', () => {
    expect(toBaseUnits('0', 7)).toBe('0')
  })

  it('throws on excess decimals', () => {
    expect(() => toBaseUnits('1.123456789', 7)).toThrow('Precision loss')
  })

  it('pads fewer decimals', () => {
    expect(toBaseUnits('1.5', 7)).toBe('15000000')
  })

  it('handles negative amounts correctly', () => {
    expect(toBaseUnits('-1.5', 7)).toBe('-15000000')
    expect(toBaseUnits('-0.01', 7)).toBe('-100000')
  })

  it('throws on multiple decimal points', () => {
    expect(() => toBaseUnits('1.2.3', 7)).toThrow('multiple decimal points')
  })

  it('handles decimals=0', () => {
    expect(toBaseUnits('42', 0)).toBe('42')
  })
})

describe('fromBaseUnits', () => {
  it('converts base units to human-readable', () => {
    expect(fromBaseUnits('10000000', 7)).toBe('1.0000000')
  })

  it('converts small amounts', () => {
    expect(fromBaseUnits('100000', 7)).toBe('0.0100000')
  })

  it('roundtrips', () => {
    const base = toBaseUnits('42.1234567', 7)
    expect(fromBaseUnits(base, 7)).toBe('42.1234567')
  })

  it('handles negative amounts correctly', () => {
    expect(fromBaseUnits('-15000000', 7)).toBe('-1.5000000')
    expect(fromBaseUnits('-5000000', 7)).toBe('-0.5000000')
  })

  it('roundtrips negative amounts', () => {
    const base = toBaseUnits('-1.5', 7)
    expect(fromBaseUnits(base, 7)).toBe('-1.5000000')
  })

  it('handles decimals=0 without trailing dot', () => {
    expect(fromBaseUnits('100', 0)).toBe('100')
  })
})

// ---------------------------------------------------------------------------
// Method schema
// ---------------------------------------------------------------------------

describe('Methods.charge', () => {
  it('has correct name and intent', () => {
    expect(Methods.charge.name).toBe('stellar')
    expect(Methods.charge.intent).toBe('charge')
  })

  it('is a valid Method', () => {
    const method = Method.from(Methods.charge)
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('charge')
  })

  it('request schema parses amount and currency', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
    })
    expect(result.amount).toBe('100000')
    expect(result.currency).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')
    expect(result.recipient).toBe('GBXYZ')
  })

  it('request schema accepts externalId', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
      externalId: 'order-123',
    })
    expect(result.externalId).toBe('order-123')
  })

  it('request schema accepts methodDetails with network and feePayer', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
      methodDetails: {
        network: 'stellar:testnet',
        feePayer: true,
      },
    })
    expect(result.methodDetails?.network).toBe('stellar:testnet')
    expect(result.methodDetails?.feePayer).toBe(true)
  })

  it('request schema accepts methodDetails with network only', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
      methodDetails: {
        network: 'stellar:pubnet',
      },
    })
    expect(result.methodDetails?.network).toBe('stellar:pubnet')
    expect(result.methodDetails?.feePayer).toBeUndefined()
  })

  it('request schema allows omitting methodDetails', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
    })
    expect(result.methodDetails).toBeUndefined()
  })

  it('request schema accepts credentialTypes in methodDetails', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['signedHash', 'transaction'],
      },
    })
    expect(result.methodDetails?.credentialTypes).toEqual(['signedHash', 'transaction'])
  })

  it('request schema requires network in methodDetails', () => {
    const result = Methods.charge.schema.request.parse({
      amount: '100000',
      currency: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      recipient: 'GBXYZ',
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['signedHash'],
      },
    })
    expect(result.methodDetails?.network).toBe('stellar:testnet')
    expect(result.methodDetails?.credentialTypes).toEqual(['signedHash'])
  })

  it('credential payload accepts signedHash type (push) with both hash and sourceSignature', () => {
    const hash = 'a'.repeat(64)
    const sourceSignature = 'b'.repeat(128)
    const result = Methods.charge.schema.credential.payload.parse({
      type: 'signedHash',
      hash,
      sourceSignature,
    })
    expect(result.type).toBe('signedHash')
    if (result.type === 'signedHash') {
      expect(result.hash).toBe(hash)
      expect(result.sourceSignature).toBe(sourceSignature)
    }
  })

  it('credential payload rejects signedHash without sourceSignature', () => {
    const hash = 'a'.repeat(64)
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'signedHash',
        hash,
      }),
    ).toThrow()
  })

  it('credential payload rejects signedHash with invalid hash format', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'signedHash',
        hash: 'abc123',
        sourceSignature: 'b'.repeat(128),
      }),
    ).toThrow()
  })

  it('credential payload rejects signedHash with invalid sourceSignature format', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'signedHash',
        hash: 'a'.repeat(64),
        sourceSignature: 'xyz',
      }),
    ).toThrow()
  })

  it('credential payload accepts legacy hash type (push receive-only) without sourceSignature', () => {
    const hash = 'a'.repeat(64)
    const result = Methods.charge.schema.credential.payload.parse({
      type: 'hash',
      hash,
    })
    expect(result.type).toBe('hash')
    if (result.type === 'hash') {
      expect(result.hash).toBe(hash)
      // sourceSignature should not be present in legacy hash
      expect(result).not.toHaveProperty('sourceSignature')
    }
  })

  it('credential payload accepts legacy hash even if extra sourceSignature key is included (stripped by Zod)', () => {
    const hash = 'a'.repeat(64)
    const sourceSignature = 'b'.repeat(128)
    const result = Methods.charge.schema.credential.payload.parse({
      type: 'hash',
      hash,
      sourceSignature, // extra field, should be stripped
    })
    expect(result.type).toBe('hash')
    if (result.type === 'hash') {
      expect(result.hash).toBe(hash)
      // sourceSignature should not exist in result
      expect(result).not.toHaveProperty('sourceSignature')
    }
  })

  it('credential payload rejects legacy hash with invalid format', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'hash',
        hash: 'abc123',
      }),
    ).toThrow()
  })

  it('credential payload rejects legacy hash that is not hex', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'hash',
        hash: 'zzzz' + '0'.repeat(60),
      }),
    ).toThrow()
  })

  it('credential payload accepts transaction type (pull) unchanged', () => {
    const result = Methods.charge.schema.credential.payload.parse({
      type: 'transaction',
      transaction: 'AAAA...',
    })
    expect(result.type).toBe('transaction')
    if (result.type === 'transaction') {
      expect(result.transaction).toBe('AAAA...')
    }
  })

  it('credential payload rejects oversized transaction XDR', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'transaction',
        transaction: 'A'.repeat(8193),
      }),
    ).toThrow()
  })

  it('credential payload accepts transaction XDR at the size limit', () => {
    const result = Methods.charge.schema.credential.payload.parse({
      type: 'transaction',
      transaction: 'A'.repeat(8192),
    })
    expect(result.type).toBe('transaction')
  })

  it('credential payload rejects unknown type', () => {
    expect(() =>
      Methods.charge.schema.credential.payload.parse({
        type: 'unknownType',
        hash: 'a'.repeat(64),
      }),
    ).toThrow()
  })
})
