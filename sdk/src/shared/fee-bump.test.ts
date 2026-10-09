import {
  Account,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { PaymentVerificationError } from './errors.js'
import { wrapFeeBump } from './fee-bump.js'

const NETWORK = Networks.TESTNET
const CONTRACT = new Contract(StrKey.encodeContract(Buffer.alloc(32)))

/**
 * Builds an inner transaction with `ops` contract calls at `baseFee` per
 * operation. A resource fee, when given, is added on top, as `build()` does
 * for a Soroban transaction.
 */
function buildInner(opts: { ops?: number; baseFee?: string; resourceFee?: number }): Transaction {
  const { ops = 1, baseFee = '100', resourceFee } = opts
  const builder = new TransactionBuilder(new Account(Keypair.random().publicKey(), '1'), {
    fee: baseFee,
    networkPassphrase: NETWORK,
  })
  for (let i = 0; i < ops; i++) {
    builder.addOperation(CONTRACT.call('noop'))
  }
  if (resourceFee !== undefined) {
    builder.setSorobanData(new SorobanDataBuilder().setResourceFee(resourceFee).build())
  }
  return builder.setTimeout(30).build()
}

describe('wrapFeeBump', () => {
  it('bases the outer fee on 10x the inclusion fee for a classic transaction', () => {
    const signer = Keypair.random()
    const inner = buildInner({ baseFee: '100' })

    const result = wrapFeeBump(inner, signer, { networkPassphrase: NETWORK })

    // base = min(10 * 100, 10_000_000 / 2) = 1000; outer = 1000 * (1 + 1)
    expect(result).toBeInstanceOf(FeeBumpTransaction)
    expect(result.fee).toBe('2000')
    expect((result as FeeBumpTransaction).feeSource).toBe(signer.publicKey())
  })

  it('caps the outer fee at maxFeeStroops when 10x the inclusion fee exceeds it', () => {
    const inner = buildInner({ baseFee: '1000' })

    const result = wrapFeeBump(inner, Keypair.random(), {
      networkPassphrase: NETWORK,
      maxFeeStroops: 5000,
    })

    // base = min(10 * 1000, 5000 / 2) = 2500; outer = 2500 * 2
    expect(result.fee).toBe('5000')
  })

  it('divides the cap by the operation count plus the fee-bump operation', () => {
    const inner = buildInner({ ops: 2, baseFee: '100' })

    const result = wrapFeeBump(inner, Keypair.random(), { networkPassphrase: NETWORK })

    // base = min(10 * 200, 10_000_000 / 3) = 2000; outer = 2000 * (2 + 1)
    expect(result.fee).toBe('6000')
  })

  it('keeps the outer fee within the cap when the inner transaction has a resource fee', () => {
    const inner = buildInner({ baseFee: '100', resourceFee: 5_000_000 })
    expect(inner.fee).toBe('5000100')

    const result = wrapFeeBump(inner, Keypair.random(), {
      networkPassphrase: NETWORK,
      maxFeeStroops: 10_000_000,
    })

    // inclusion = 5_000_100 - 5_000_000 = 100; base = min(1000, (10_000_000 - 5_000_000) / 2)
    // outer = 1000 * (1 + 1) + 5_000_000, which the SDK adds once for the resource fee
    expect(result.fee).toBe('5002000')
    expect(Number(result.fee)).toBeLessThanOrEqual(10_000_000)
  })

  it('refuses when the cap cannot cover the inner inclusion fee and the fee-bump operation', () => {
    // A cap equal to the inner fee leaves 50 stroops per operation, below the
    // 100 stroop inclusion fee the inner transaction already pays.
    const inner = buildInner({ baseFee: '100', resourceFee: 5_000_000 })

    let error: unknown
    try {
      wrapFeeBump(inner, Keypair.random(), {
        networkPassphrase: NETWORK,
        maxFeeStroops: 5_000_100,
      })
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(PaymentVerificationError)
    expect((error as Error).message).toBe(
      'Fee bump exceeds the configured maximum: the cap cannot cover the inner transaction fee.',
    )
    expect((error as PaymentVerificationError).details).toEqual({
      fee: '5000100',
      resourceFee: 5_000_000,
      innerOps: 1,
      maxFeeStroops: 5_000_100,
      minBaseFee: 100,
    })
  })

  it('returns an already-wrapped FeeBumpTransaction unchanged', () => {
    const signer = Keypair.random()
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      signer,
      '1000',
      buildInner({}),
      NETWORK,
    )

    expect(wrapFeeBump(feeBump, signer, { networkPassphrase: NETWORK })).toBe(feeBump)
  })

  it('refuses an already-wrapped FeeBumpTransaction whose outer fee exceeds the cap', () => {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '1000',
      buildInner({}),
      NETWORK,
    )
    expect(feeBump.fee).toBe('2000')

    expect(() =>
      wrapFeeBump(feeBump, Keypair.random(), { networkPassphrase: NETWORK, maxFeeStroops: 1999 }),
    ).toThrow(PaymentVerificationError)
    expect(() =>
      wrapFeeBump(feeBump, Keypair.random(), { networkPassphrase: NETWORK, maxFeeStroops: 1999 }),
    ).toThrow('Fee bump exceeds the configured maximum: the outer fee is above the cap.')
  })

  it('returns an already-wrapped FeeBumpTransaction at the cap unchanged', () => {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '1000',
      buildInner({}),
      NETWORK,
    )

    const result = wrapFeeBump(feeBump, Keypair.random(), {
      networkPassphrase: NETWORK,
      maxFeeStroops: 2000,
    })

    expect(result).toBe(feeBump)
  })
})
