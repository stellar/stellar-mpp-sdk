import { describe, it, expect } from 'vitest'
import { Errors } from 'mppx'
import {
  StellarMppError,
  PaymentVerificationError,
  ChannelVerificationError,
  SettlementError,
} from './errors.js'

describe('StellarMppError', () => {
  it('stores message and details', () => {
    const err = new StellarMppError('test error', { key: 'value' })
    expect(err.message).toBe('test error')
    expect(err.details).toEqual({ key: 'value' })
    expect(err).toBeInstanceOf(Error)
  })

  it('defaults details to empty object', () => {
    const err = new StellarMppError('test')
    expect(err.details).toEqual({})
  })
})

describe('PaymentVerificationError', () => {
  it('extends StellarMppError', () => {
    const err = new PaymentVerificationError('payment failed', { hash: 'abc' })
    expect(err).toBeInstanceOf(StellarMppError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PaymentVerificationError')
    expect(err.details).toEqual({ hash: 'abc' })
  })
})

describe('ChannelVerificationError', () => {
  it('extends StellarMppError', () => {
    const err = new ChannelVerificationError('channel failed', { channel: 'C...' })
    expect(err).toBeInstanceOf(StellarMppError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ChannelVerificationError')
    expect(err.details).toEqual({ channel: 'C...' })
  })
})

describe('SettlementError', () => {
  it('extends StellarMppError', () => {
    const err = new SettlementError('settlement failed', { hash: 'abc' })
    expect(err).toBeInstanceOf(StellarMppError)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SettlementError')
    expect(err.details).toEqual({ hash: 'abc' })
  })
})

describe('mppx PaymentError mapping', () => {
  it('maps verification errors to a 402 verification-failed problem', () => {
    for (const err of [
      new StellarMppError('base', { key: 'value' }),
      new PaymentVerificationError('payment', { key: 'value' }),
      new ChannelVerificationError('channel', { key: 'value' }),
    ]) {
      expect(err).toBeInstanceOf(Errors.PaymentError)
      expect(err.status).toBe(402)
      expect(err.toProblemDetails('challenge-1')).toEqual({
        type: 'https://paymentauth.org/problems/verification-failed',
        title: 'Verification Failed',
        status: 402,
        detail: err.message,
        challengeId: 'challenge-1',
      })
    }
  })

  it('maps SettlementError to a generic 500 without its message or details', () => {
    const err = new SettlementError('settlement failed', { details: 'RPC unreachable' })
    expect(err).toBeInstanceOf(Errors.PaymentError)
    expect(err.status).toBe(500)
    expect(err.toProblemDetails('challenge-1')).toEqual({
      type: 'https://paymentauth.org/problems/internal-payment-error',
      title: 'Internal Payment Error',
      status: 500,
      detail: 'An internal payment error occurred.',
      challengeId: 'challenge-1',
    })
  })
})
