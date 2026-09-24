import { Errors } from 'mppx'

/**
 * Base class for SDK errors. Extends mppx's `PaymentError` so the mppx server
 * handler answers a rejected credential with a 402 and a fresh challenge
 * instead of treating it as an internal fault.
 */
export class StellarMppError extends Errors.PaymentError {
  public readonly details: Record<string, unknown>
  readonly type: string = 'https://paymentauth.org/problems/verification-failed'
  readonly title: string = 'Verification Failed'

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = this.constructor.name
    this.details = details
  }

  /**
   * Omits `details` from the client-facing problem: it carries server-side
   * diagnostics (configuration, RPC errors) meant for logs, not for clients.
   */
  override toProblemDetails(challengeId?: string): Errors.PaymentError.ProblemDetails {
    const { details: _details, ...problem } = super.toProblemDetails(challengeId)
    return problem
  }
}

export class PaymentVerificationError extends StellarMppError {}

/**
 * A settlement that failed or whose outcome is unknown after the credential
 * was verified (broadcast rejected, RPC unreachable, confirmation timed out).
 * Answers with a generic 500, not a 402: the payment may still land on-chain,
 * so the client must not treat it as a rejected credential and pay again.
 */
export class SettlementError extends StellarMppError {
  override readonly status = 500
  override readonly type: string = 'https://paymentauth.org/problems/internal-payment-error'
  override readonly title: string = 'Internal Payment Error'

  override toProblemDetails(challengeId?: string): Errors.PaymentError.ProblemDetails {
    return new Errors.InternalPaymentError().toProblemDetails(challengeId)
  }
}

export class ChannelVerificationError extends StellarMppError {}
