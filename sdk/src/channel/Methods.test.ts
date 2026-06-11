import { describe, expect, it } from 'vitest'
import { Method } from 'mppx'
import { channel } from './Methods.js'

describe('channel method schema', () => {
  it('has correct name and intent', () => {
    expect(channel.name).toBe('stellar')
    expect(channel.intent).toBe('channel')
  })

  it('is a valid Method', () => {
    const method = Method.from(channel)
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('channel')
  })

  it('request schema parses amount and channel', () => {
    const result = channel.schema.request.parse({
      amount: '1000000',
      channel: 'CABC123',
    })
    expect(result.amount).toBe('1000000')
    expect(result.channel).toBe('CABC123')
  })

  it('request schema accepts externalId', () => {
    const result = channel.schema.request.parse({
      amount: '1000000',
      channel: 'CABC123',
      externalId: 'order-456',
    })
    expect(result.externalId).toBe('order-456')
  })

  it('request schema accepts methodDetails with cumulativeAmount', () => {
    const result = channel.schema.request.parse({
      amount: '1000000',
      channel: 'CABC123',
      methodDetails: {
        reference: 'ref-001',
        network: 'stellar:testnet',
        cumulativeAmount: '5000000',
      },
    })
    expect(result.methodDetails?.reference).toBe('ref-001')
    expect(result.methodDetails?.network).toBe('stellar:testnet')
    expect(result.methodDetails?.cumulativeAmount).toBe('5000000')
  })

  it('request schema allows omitting methodDetails', () => {
    const result = channel.schema.request.parse({
      amount: '1000000',
      channel: 'CABC123',
    })
    expect(result.methodDetails).toBeUndefined()
  })

  it('credential payload accepts voucher action with amount and signature', () => {
    const validSig = 'a'.repeat(128)
    const result = channel.schema.credential.payload.parse({
      action: 'voucher',
      amount: '3000000',
      signature: validSig,
    })
    expect(result.action).toBe('voucher')
    expect(result.amount).toBe('3000000')
    expect(result.signature).toBe(validSig)
  })

  it('credential payload accepts close action', () => {
    const validSig = 'a'.repeat(128)
    const result = channel.schema.credential.payload.parse({
      action: 'close',
      amount: '5000000',
      signature: validSig,
    })
    expect(result.action).toBe('close')
    expect(result.amount).toBe('5000000')
  })

  it('credential payload rejects non-numeric amount', () => {
    expect(() =>
      channel.schema.credential.payload.parse({
        action: 'voucher',
        amount: 'abc',
        signature: 'a'.repeat(128),
      }),
    ).toThrow()
  })

  it('credential payload rejects invalid hex signature', () => {
    expect(() =>
      channel.schema.credential.payload.parse({
        action: 'voucher',
        amount: '1000000',
        signature: 'not-hex',
      }),
    ).toThrow()
  })

  it('credential payload rejects wrong-length signature', () => {
    expect(() =>
      channel.schema.credential.payload.parse({
        action: 'voucher',
        amount: '1000000',
        signature: 'abcdef',
      }),
    ).toThrow()
  })

  it('credential payload rejects unknown action', () => {
    expect(() =>
      channel.schema.credential.payload.parse({
        action: 'topUp',
        amount: '1000000',
        signature: 'a'.repeat(128),
      }),
    ).toThrow()
  })

  it('credential payload rejects the removed "open" action', () => {
    // The MPP open path was removed: the channel contract is deployed
    // out-of-band, so no client may drive an on-chain open via a credential.
    expect(() =>
      channel.schema.credential.payload.parse({
        action: 'open',
        transaction: 'AAAA',
        amount: '1000000',
        signature: 'a'.repeat(128),
      }),
    ).toThrow()
  })
})
