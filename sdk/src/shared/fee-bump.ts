import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { DEFAULT_MAX_FEE_BUMP_STROOPS } from './defaults.js'
import { PaymentVerificationError } from './errors.js'

/** Lowest per-operation base fee the network accepts. */
const MIN_BASE_FEE_STROOPS = 100

/** Soroban resource fee of a transaction, or 0 for a classic transaction. */
function resourceFeeOf(tx: Transaction): number {
  const envelope = tx.toEnvelope()
  if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) return 0
  const sorobanData = envelope.v1().tx().ext().value()
  return sorobanData ? Number(sorobanData.resourceFee().toBigInt()) : 0
}

/**
 * Wraps a transaction in a `FeeBumpTransaction`.
 *
 * The inner transaction's source account and signatures remain intact — the
 * outer fee bump only overrides who pays the network fee at the protocol
 * level.
 *
 * The outer fee is `baseFee * (innerOps + 1) + resourceFee`, so the base fee is
 * sized to keep that total at or below `maxFeeStroops`: the base is at most
 * 10x the inner inclusion fee, and never above what the cap allows.
 *
 * Already-wrapped `FeeBumpTransaction` instances are returned unchanged.
 *
 * @throws {PaymentVerificationError} If `maxFeeStroops` cannot cover the inner
 *   inclusion fee at the per-operation minimum, so no valid base fee exists.
 */
export function wrapFeeBump(
  tx: Transaction | FeeBumpTransaction,
  signer: Keypair,
  opts: {
    networkPassphrase: string
    maxFeeStroops?: number
  },
): Transaction | FeeBumpTransaction {
  if (tx instanceof FeeBumpTransaction) {
    return tx
  }

  const { networkPassphrase, maxFeeStroops = DEFAULT_MAX_FEE_BUMP_STROOPS } = opts
  const innerOps = tx.operations.length
  const resourceFee = resourceFeeOf(tx)
  const inclusionFee = Number(tx.fee) - resourceFee
  const minBaseFee = Math.max(Math.ceil(inclusionFee / innerOps), MIN_BASE_FEE_STROOPS)
  const capBaseFee = Math.floor((maxFeeStroops - resourceFee) / (innerOps + 1))
  const baseFee = Math.min(inclusionFee * 10, capBaseFee)

  if (baseFee < minBaseFee) {
    throw new PaymentVerificationError(
      'Fee bump exceeds the configured maximum: the cap cannot cover the inner transaction fee.',
      { fee: tx.fee, resourceFee, innerOps, maxFeeStroops, minBaseFee },
    )
  }

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    signer,
    baseFee.toString(),
    tx,
    networkPassphrase,
  )
  feeBumpTx.sign(signer)
  return feeBumpTx
}
