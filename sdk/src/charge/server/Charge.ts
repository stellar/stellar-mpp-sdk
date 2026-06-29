import {
  Account,
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { type Challenge, type Credential, Method, Receipt, Store } from 'mppx'
import type { z } from 'zod/mini'
import {
  ALL_ZEROS,
  DEFAULT_CHALLENGE_EXPIRY,
  DEFAULT_DECIMALS,
  DEFAULT_LEDGER_CLOSE_TIME,
  DEFAULT_TIMEOUT,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
  type NetworkId,
} from '../../constants.js'
import * as Methods from '../Methods.js'
import { toBaseUnits } from '../Methods.js'
import { scValToBigInt } from '../../shared/scval.js'
import { resolveKeypair } from '../../shared/keypairs.js'
import { pollTransaction } from '../../shared/poll.js'
import { wrapFeeBump } from '../../shared/fee-bump.js'
import { PaymentVerificationError, SettlementError } from '../../shared/errors.js'
import { noopLogger, type Logger } from '../../shared/logger.js'
import { SimulationContractError, simulateCall } from '../../shared/simulate.js'
import { verifyInvokeContractOp } from '../../shared/verify-invoke.js'
import { verifyAuthEntrySignature } from '../../shared/verify-auth.js'
import {
  DEFAULT_MAX_FEE_BUMP_STROOPS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_MAX_CONCURRENT,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SIMULATION_TIMEOUT_MS,
  DEFAULT_MAX_PUSH_PAYMENT_AGE_SECONDS,
} from '../../shared/defaults.js'
import { Semaphore } from '../../shared/semaphore.js'

type ChargePayload = z.output<(typeof Methods.charge)['schema']['credential']['payload']>
type ChargeRequest = z.output<(typeof Methods.charge)['schema']['request']>
type ChargeCredential = Credential.Credential<
  ChargePayload,
  Challenge.Challenge<ChargeRequest, 'charge', 'stellar'>
>

const LOG_PREFIX = '[stellar:charge]'
const STORE_PREFIX = 'stellar:charge'

// Tolerance, in seconds, between a payment's on-chain confirmation time and the
// challenge issuance it is anchored against, absorbing clock drift between the
// ledger and the verifying server.
const PUSH_PAYMENT_CLOCK_SKEW_SECONDS = 30

// Tolerance, in ledgers, when bounding a sponsored auth entry's expiration. The
// client and the server read the latest ledger at different moments from a
// load-balanced RPC, so the client's view can sit a few ledgers ahead of the
// server's. Without this margin a legitimate payment would be rejected for an
// expiration only trivially beyond the strict bound.
const AUTH_EXPIRATION_LEDGER_SKEW = 10

/**
 * Creates a Stellar charge method for use on the **server**.
 *
 * Verifies and settles SEP-41 token `transfer` invocations received as
 * pull-mode (signed XDR) or push-mode (on-chain tx hash) credentials.
 *
 * @see https://paymentauth.org/draft-stellar-charge-00
 */
export function charge(parameters: charge.Parameters) {
  if (!parameters.store) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} A store is required for charge mode. Provide a Store instance for replay protection and transaction hash deduplication.`,
      {},
    )
  }

  if (typeof parameters.store.update !== 'function') {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} An atomic store providing compare-and-set semantics via update() is required for replay protection.`,
      {},
    )
  }

  const {
    currency,
    decimals = DEFAULT_DECIMALS,
    feePayer,
    logger = noopLogger,
    maxFeeBumpStroops = DEFAULT_MAX_FEE_BUMP_STROOPS,
    network = STELLAR_TESTNET,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollMaxConcurrent = DEFAULT_POLL_MAX_CONCURRENT,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    recipient,
    allowUnsignedPush = false,
    maxPushPaymentAgeSeconds = DEFAULT_MAX_PUSH_PAYMENT_AGE_SECONDS,
    challengeLifetimeSeconds = DEFAULT_CHALLENGE_EXPIRY,
    rpcUrl,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
    store,
  } = parameters

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const networkPassphrase = NETWORK_PASSPHRASE[network]
  const rpcServer = new rpc.Server(resolvedRpcUrl)
  const pollSemaphore = new Semaphore(pollMaxConcurrent)

  const envelopeKP = feePayer ? resolveKeypair(feePayer.envelopeSigner) : undefined
  const feeBumpKP = feePayer?.feeBumpSigner ? resolveKeypair(feePayer.feeBumpSigner) : undefined

  // Compute credentialTypes: sponsored servers advertise only 'transaction' (pull mode).
  // Unsponsored servers advertise push modes based on allowUnsignedPush.
  const credentialTypes = envelopeKP
    ? ['transaction']
    : allowUnsignedPush
      ? ['transaction', 'signedHash', 'hash']
      : ['transaction', 'signedHash']

  if (feeBumpKP) {
    logger.warn(
      `${LOG_PREFIX} A fee-bump signer is configured — ensure it is funded with XLM. An unfunded fee-bump signer is accepted silently but causes every sponsored fee-bump settlement to fail at broadcast time.`,
    )
  }

  return Method.toServer(Methods.charge, {
    defaults: { currency, recipient },
    request({ request }) {
      return {
        ...request,
        amount: toBaseUnits(request.amount, decimals),
        methodDetails: {
          network,
          ...(envelopeKP ? { feePayer: true } : {}),
          credentialTypes,
        },
      }
    },
    async verify({ credential }) {
      return doVerify(credential)
    },
  })

  /**
   * Verifies a charge credential (hash or transaction) and settles it on-chain.
   *
   * Dispatches to push mode (on-chain hash lookup) or pull mode (server-broadcast
   * XDR) based on `payload.type`. Concurrent calls are safe: atomic store.update()
   * prevents cross-process TOCTOU races via compare-and-set semantics.
   */
  // Reject push settlements whose on-chain payment is older than the accepted
  // window, so a transfer confirmed before the challenge cannot be presented as
  // its settlement.
  function assertPaymentIsFresh(
    createdAt: number | string | undefined,
    challenge: Challenge.Challenge<ChargeRequest, 'charge', 'stellar'>,
  ): void {
    // The RPC omits createdAt only when it has no age to report; with no signal
    // to bound, keep the prior conservative acceptance for an absent value.
    if (createdAt === undefined) return
    // Soroban RPC encodes createdAt as a JSON string of unix seconds even though
    // the typings advertise a number, so coerce both shapes. Refuse to settle on
    // any present value we cannot read as an age: a payment whose age is unknown
    // must never be treated as fresh enough to settle a challenge.
    const seconds = typeof createdAt === 'number' ? createdAt : Number(createdAt)
    if (!Number.isFinite(seconds)) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} On-chain payment age is unavailable; refusing to settle this challenge.`,
      )
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - seconds
    if (ageSeconds > maxPushPaymentAgeSeconds) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} On-chain payment is too old to settle this challenge.`,
        { ageSeconds, maxAgeSeconds: maxPushPaymentAgeSeconds },
      )
    }
    // Anchor freshness to this challenge: a transfer confirmed before the
    // challenge was issued cannot be its settlement. Issuance is derived from
    // the challenge's expiry and the configured lifetime, with a clock-skew
    // budget so honest near-issuance payments are not rejected.
    if (challenge.expires) {
      const expiresAt = Math.floor(new Date(challenge.expires).getTime() / 1000)
      if (!Number.isFinite(expiresAt)) {
        throw new PaymentVerificationError(
          `${LOG_PREFIX} Challenge expiry is unreadable; refusing to settle this challenge.`,
        )
      }
      const issuedAt = expiresAt - challengeLifetimeSeconds
      if (seconds < issuedAt - PUSH_PAYMENT_CLOCK_SKEW_SECONDS) {
        throw new PaymentVerificationError(
          `${LOG_PREFIX} On-chain payment predates challenge issuance; cannot settle this challenge.`,
          { createdAt: seconds, issuedAt },
        )
      }
    }
  }

  async function doVerify(credential: ChargeCredential) {
    const { challenge, source } = credential
    const { request: challengeRequest } = challenge

    // Replay protection via atomic compare-and-set: reject if challenge already claimed.
    const challengeStoreKey = `${STORE_PREFIX}:challenge:${challenge.id}`
    const challengeReplayError = new PaymentVerificationError(
      `${LOG_PREFIX} Challenge already used. Replay rejected.`,
    )
    const claimResult = await store.update(challengeStoreKey, (current) =>
      current
        ? { op: 'noop', result: 'replay' as const }
        : {
            op: 'set',
            value: { state: 'pending', claimedAt: new Date().toISOString() },
            result: 'claimed' as const,
          },
    )
    if (claimResult === 'replay') {
      throw challengeReplayError
    }

    const { amount, externalId } = challengeRequest
    const expectedCurrency = challengeRequest.currency
    const expectedRecipient = challengeRequest.recipient
    const expectedAmount = BigInt(amount)

    const payload = credential.payload

    switch (payload.type) {
      case 'signedHash': {
        // Spec: push mode MUST NOT be used with feePayer=true
        if (challengeRequest.methodDetails?.feePayer) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Push mode (type="signedHash") is not allowed with feePayer=true.`,
          )
        }

        let hash = payload.hash

        // Reject obviously invalid hashes before any expensive work.
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
          throw new PaymentVerificationError(`${LOG_PREFIX} Invalid transaction hash format.`, {
            hash,
          })
        }

        // Canonicalize hash to lowercase for case-insensitive consistency
        hash = hash.toLowerCase()

        // Push mode requires the transaction to be confirmed on-chain before the
        // client submits the hash. Look it up first: the client-presented hash may
        // be the inner tx hash or the outer fee-bump hash, and the dedup key must be
        // the canonical INNER transaction hash so push and pull (which also keys on
        // the inner hash) settle each on-chain payment at most once.
        const result = await rpcServer.getTransaction(hash)

        if (result.status === 'FAILED') {
          throw new PaymentVerificationError(`${LOG_PREFIX} Transaction failed on-chain.`, {
            hash,
            ...(result.resultXdr ? { resultXdr: result.resultXdr } : {}),
          })
        }

        if (result.status !== 'SUCCESS') {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Transaction not found on-chain. Push mode requires the transaction to be confirmed before submitting the hash.`,
            { hash, status: result.status },
          )
        }

        const txResult = result as rpc.Api.GetSuccessfulTransactionResponse

        assertPaymentIsFresh(txResult.createdAt, challenge)

        // Extract the payer's public key from the credential DID to verify the
        // on-chain transfer's `from` matches the claimed payer. The returned value
        // is the canonical inner transaction hash used for dedup below.
        const expectedFrom = publicKeyFromDID(source)
        const canonicalHash = verifyTokenTransferFromResult(
          txResult,
          {
            amount: expectedAmount,
            currency: expectedCurrency,
            recipient: expectedRecipient,
            from: expectedFrom,
          },
          networkPassphrase,
        )

        // Verify the source signature proves the submitter controls the payer account.
        // The signature must be over "{challenge.id}:{hash}" (the client-presented,
        // lowercase hash). This binds the credential to both the challenge and the
        // submitted tx hash, so the claimed source must control the payer account.
        const bindingMessage = Buffer.from(`${challenge.id}:${hash}`)
        try {
          const isValid = Keypair.fromPublicKey(expectedFrom).verify(
            bindingMessage,
            Buffer.from(payload.sourceSignature, 'hex'),
          )
          if (!isValid) {
            throw new PaymentVerificationError(
              `${LOG_PREFIX} Source signature does not authorize this payment; the credential holder must prove control of the payer account.`,
              {},
            )
          }
        } catch (err) {
          if (err instanceof PaymentVerificationError) throw err
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Source signature does not authorize this payment; the credential holder must prove control of the payer account.`,
            {},
          )
        }

        // Tx hash dedup via atomic compare-and-set on the canonical inner hash.
        // The claim runs after verification so a failed check never burns the
        // payment's dedup slot (which would otherwise let anyone lock out a payer's
        // legitimate settlement). Each on-chain payment settles at most once,
        // shared with pull-mode hashes.
        const hashKey = `${STORE_PREFIX}:hash:${canonicalHash}`
        const hashClaimResult = await store.update(hashKey, (current) =>
          current
            ? { op: 'noop', result: 'replay' as const }
            : {
                op: 'set',
                value: { state: 'used', usedAt: new Date().toISOString() },
                result: 'claimed' as const,
              },
        )
        if (hashClaimResult === 'replay') {
          logger.warn(`${LOG_PREFIX} Verification failed`, {
            error: 'Transaction hash already used',
            hash: canonicalHash,
          })
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Transaction hash already used. Replay rejected.`,
            { hash: canonicalHash },
          )
        }

        await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

        return Receipt.from({
          method: 'stellar',
          reference: hash,
          status: 'success',
          timestamp: new Date().toISOString(),
          ...(externalId ? { externalId } : {}),
        })
      }

      case 'hash': {
        // Legacy receive-only push mode: client broadcasts and sends only the tx hash
        // (without source signature). Server looks it up on-chain for verification.
        // Spec: push mode MUST NOT be used with feePayer=true
        if (challengeRequest.methodDetails?.feePayer) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Push mode (type="hash") is not allowed with feePayer=true.`,
          )
        }

        // Check if unsigned push is rejected by policy
        if (!allowUnsignedPush) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Unsigned push mode (type="hash") is no longer accepted. Upgrade your client to send type="signedHash", or use server-sponsored flow.`,
          )
        }

        let hash = payload.hash

        // Reject obviously invalid hashes before any expensive work.
        if (!/^[0-9a-f]{64}$/i.test(hash)) {
          throw new PaymentVerificationError(`${LOG_PREFIX} Invalid transaction hash format.`, {
            hash,
          })
        }

        // Canonicalize hash to lowercase for case-insensitive consistency
        hash = hash.toLowerCase()

        // Push mode requires the transaction to be confirmed on-chain before the
        // client submits the hash. Look it up first to derive the canonical INNER
        // transaction hash for dedup (a fee-bump exposes both an inner and an outer
        // hash; both push and pull settle each on-chain payment at most once on the
        // inner hash).
        const result = await rpcServer.getTransaction(hash)

        if (result.status === 'FAILED') {
          throw new PaymentVerificationError(`${LOG_PREFIX} Transaction failed on-chain.`, {
            hash,
            ...(result.resultXdr ? { resultXdr: result.resultXdr } : {}),
          })
        }

        if (result.status !== 'SUCCESS') {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Transaction not found on-chain. Push mode requires the transaction to be confirmed before submitting the hash.`,
            { hash, status: result.status },
          )
        }

        const txResult = result as rpc.Api.GetSuccessfulTransactionResponse

        assertPaymentIsFresh(txResult.createdAt, challenge)

        // Extract the payer's public key from the credential DID to verify the
        // on-chain transfer's `from` matches the claimed payer. The returned value
        // is the canonical inner transaction hash used for dedup below.
        // Note: legacy hash type does not verify sourceSignature.
        // For source signature verification, use type="signedHash".
        const expectedFrom = publicKeyFromDID(source)
        const canonicalHash = verifyTokenTransferFromResult(
          txResult,
          {
            amount: expectedAmount,
            currency: expectedCurrency,
            recipient: expectedRecipient,
            from: expectedFrom,
          },
          networkPassphrase,
        )

        // Log acceptance of legacy unsigned push for operator visibility
        logger.warn(`${LOG_PREFIX} Accepting unsigned push (legacy mode)`, {
          challengeId: challenge.id,
          hash,
        })

        // Tx hash dedup via atomic compare-and-set on the canonical inner hash,
        // after verification so a failed check never burns the payment's dedup slot.
        const hashKey = `${STORE_PREFIX}:hash:${canonicalHash}`
        const hashClaimResult = await store.update(hashKey, (current) =>
          current
            ? { op: 'noop', result: 'replay' as const }
            : {
                op: 'set',
                value: { state: 'used', usedAt: new Date().toISOString() },
                result: 'claimed' as const,
              },
        )
        if (hashClaimResult === 'replay') {
          logger.warn(`${LOG_PREFIX} Verification failed`, {
            error: 'Transaction hash already used',
            hash: canonicalHash,
          })
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Transaction hash already used. Replay rejected.`,
            { hash: canonicalHash },
          )
        }

        await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

        return Receipt.from({
          method: 'stellar',
          reference: hash,
          status: 'success',
          timestamp: new Date().toISOString(),
          ...(externalId ? { externalId } : {}),
        })
      }

      case 'transaction': {
        // Until the broadcast may have reached the network, the payment is
        // definitely not on-chain, so a failure can release the challenge (and
        // tx-hash) claims and let the payer retry the same challenge instead of
        // being permanently locked out. Once the transaction may be on-chain the
        // claims are kept to prevent a double settlement; that ambiguous case is
        // surfaced for reconciliation rather than silently dropped.
        let mayBeOnChain = false
        // The tx-hash dedup slot is only ours to release if this call claimed
        // it. On a replay the slot belongs to an already-settled payment and
        // must never be deleted, or its replay protection would be undone.
        let hashKey: string | undefined
        let hashClaimedByUs = false
        try {
          const txXdr = payload.transaction

          // Detect FeeBump by inspecting the XDR envelope type directly.
          // Using explicit constructors instead of TransactionBuilder.fromXDR +
          // instanceof avoids false negatives when the FeeBumpTransaction class
          // reference differs across module boundaries (e.g. in test environments).
          const txEnvelope = xdr.TransactionEnvelope.fromXDR(txXdr, 'base64')
          const isFeeBump = txEnvelope.switch().name === 'envelopeTypeTxFeeBump'

          let tx: Transaction
          let txToSubmit: Transaction | FeeBumpTransaction
          if (isFeeBump) {
            const feeBumpTx = new FeeBumpTransaction(txEnvelope, networkPassphrase)
            tx = feeBumpTx.innerTransaction
            txToSubmit = feeBumpTx
          } else {
            tx = new Transaction(txEnvelope, networkPassphrase)
            txToSubmit = tx
          }

          verifyNoSigningAddressInSources(tx, envelopeKP)

          const expectedFrom = publicKeyFromDID(credential.source)
          verifyTokenTransfer(tx, {
            amount: expectedAmount,
            currency: expectedCurrency,
            recipient: expectedRecipient,
            from: expectedFrom,
          })

          if (!envelopeKP && tx.source === ALL_ZEROS) {
            logger.warn(`${LOG_PREFIX} Verification failed`, {
              error: 'Sponsored source without feePayer',
            })
            throw new PaymentVerificationError(
              `${LOG_PREFIX} Transaction relies on a sponsored source account but the server has no feePayer configuration.`,
              {},
            )
          }

          const expiresTimestamp: number | undefined = challenge.expires
            ? Math.floor(new Date(challenge.expires).getTime() / 1000)
            : undefined

          if (envelopeKP !== undefined && tx.source === ALL_ZEROS) {
            // ── Sponsored path ──────────────────────────────────────────

            await validateAuthEntries(tx, envelopeKP.publicKey(), expiresTimestamp, {
              currency: expectedCurrency,
              from: expectedFrom,
              to: expectedRecipient,
              amount: expectedAmount,
            })

            // Rebuild the tx with the signer's account as source
            logger.debug(`${LOG_PREFIX} Rebuilding sponsored tx...`)
            const serverAccount = await rpcServer.getAccount(envelopeKP.publicKey())
            const originalSeq = serverAccount.sequenceNumber() // needed because Transaction.build sets sequence to account's current + 1 in place.
            const envelopeTx = tx.toEnvelope().v1().tx()
            const rawOp = envelopeTx.operations()[0]

            // Build without sorobanData so simulation determines resources.
            // This consumes the account's sequence (N → N+1).
            // The server sets its own inclusion fee (BASE_FEE) rather than
            // trusting the counterparty-supplied tx.fee.
            const simBuilder = new TransactionBuilder(serverAccount, {
              fee: BASE_FEE,
              networkPassphrase,
              ...(tx.timeBounds ? { timebounds: tx.timeBounds } : {}),
            })
            simBuilder.addOperation(rawOp)
            if (!tx.timeBounds) {
              simBuilder.setTimeout(DEFAULT_TIMEOUT)
            }
            const rebuiltTx = simBuilder.build()

            // Simulate to validate transfer events and obtain accurate
            // resource data — never trust the client-supplied sorobanData.
            // Enforcement mode also validates the supplied authorization against
            // ledger state, so the server does not pay to broadcast a transfer
            // whose authorization the network would no longer honor.
            const simResponse = await simulateTransfer(rebuiltTx, { authMode: 'enforce' })
            validateSimulationEvents(simResponse.events!, {
              amount: expectedAmount,
              currency: expectedCurrency,
              recipient: expectedRecipient,
              from: expectedFrom,
              serverAddress: envelopeKP.publicKey(),
            })

            // Rebuild with server-determined resources from simulation.
            // Use a fresh Account at the original sequence so this tx
            // also gets sequence N+1 (the simulation tx is never submitted).
            const submitAccount = new Account(envelopeKP.publicKey(), originalSeq)
            const prepBuilder = new TransactionBuilder(submitAccount, {
              fee: BASE_FEE,
              networkPassphrase,
              ...(tx.timeBounds ? { timebounds: tx.timeBounds } : {}),
            })
            prepBuilder.addOperation(rawOp)
            if (!tx.timeBounds) {
              prepBuilder.setTimeout(DEFAULT_TIMEOUT)
            }
            const preparedTx = prepBuilder
              .setSorobanData(simResponse.transactionData.build())
              .build() as Transaction

            // setSorobanData adds the simulator-derived resource fee on top of the
            // inclusion fee. Cap the total the server is willing to pay so a
            // counterparty cannot drive the fee past the per-settlement limit.
            if (Number(preparedTx.fee) > maxFeeBumpStroops) {
              throw new PaymentVerificationError(
                `${LOG_PREFIX} Settlement fee exceeds the configured maximum.`,
                { fee: preparedTx.fee, maxFeeBumpStroops },
              )
            }

            preparedTx.sign(envelopeKP)
            txToSubmit = preparedTx

            // Fee bump wrapping (sponsored path only — spec requires
            // unsponsored transactions to be submitted without modification)
            if (feeBumpKP) {
              logger.debug(`${LOG_PREFIX} Fee bump wrapping`)
              txToSubmit = wrapFeeBump(txToSubmit, feeBumpKP, {
                networkPassphrase,
                maxFeeStroops: maxFeeBumpStroops,
              })
            }
          } else {
            // ── Unsponsored path ────────────────────────────────────────

            if (expiresTimestamp && tx.timeBounds) {
              const maxTime = parseInt(tx.timeBounds.maxTime, 10)
              if (maxTime > expiresTimestamp) {
                throw new PaymentVerificationError(
                  `${LOG_PREFIX} Transaction timeBounds.maxTime exceeds challenge expires.`,
                  {
                    maxTime,
                    expires: expiresTimestamp,
                  },
                )
              }
            }

            const simResponse = await simulateTransfer(tx)
            validateSimulationEvents(simResponse.events!, {
              amount: expectedAmount,
              currency: expectedCurrency,
              recipient: expectedRecipient,
              from: expectedFrom,
              serverAddress: envelopeKP?.publicKey(),
            })
          }

          // Tx hash dedup via atomic compare-and-set, just before broadcast.
          // Key on the canonical INNER hash of the transaction actually being
          // broadcast — the same key push mode derives from the on-chain
          // envelope. In the sponsored path the broadcast tx is rebuilt with the
          // server as source, so its hash differs from the client-submitted tx;
          // keying on the broadcast tx keeps pull and push converged on one slot,
          // so each on-chain payment settles at most once regardless of how it
          // arrives or whether it is wrapped in a fee-bump.
          const broadcastInnerTx =
            txToSubmit instanceof FeeBumpTransaction ? txToSubmit.innerTransaction : txToSubmit
          const txHash = broadcastInnerTx.hash().toString('hex')
          hashKey = `${STORE_PREFIX}:hash:${txHash}`
          const hashClaimResult = await store.update(hashKey, (current) =>
            current
              ? { op: 'noop', result: 'replay' as const }
              : {
                  op: 'set',
                  value: { state: 'pending', claimedAt: new Date().toISOString() },
                  result: 'claimed' as const,
                },
          )
          if (hashClaimResult === 'replay') {
            logger.warn(`${LOG_PREFIX} Verification failed`, {
              error: 'Transaction hash already used',
              hash: txHash,
            })
            throw new PaymentVerificationError(
              `${LOG_PREFIX} Transaction hash already used. Replay rejected.`,
              { hash: txHash },
            )
          }
          hashClaimedByUs = true

          // ── Settlement ──────────────────────────────────────────────
          let sendResult: rpc.Api.SendTransactionResponse
          try {
            logger.debug(`${LOG_PREFIX} Broadcasting tx`)
            sendResult = await rpcServer.sendTransaction(txToSubmit)
            logger.debug(`${LOG_PREFIX} Broadcast result`, {
              hash: sendResult.hash,
              status: sendResult.status,
            })
          } catch (error) {
            // The broadcast request may have reached the network before failing,
            // so the payment might still apply on-chain; keep the claims.
            mayBeOnChain = true
            throw new SettlementError(
              `${LOG_PREFIX} Settlement failed: could not broadcast transaction.`,
              {
                details: error instanceof Error ? error.message : String(error),
              },
            )
          }

          // A PENDING (accepted) or DUPLICATE (already submitted) status may
          // reach the ledger; any other status is a synchronous rejection that
          // never enters the mempool, so the claims can be released for retry.
          mayBeOnChain = sendResult.status === 'PENDING' || sendResult.status === 'DUPLICATE'

          if (sendResult.status !== 'PENDING') {
            throw new SettlementError(
              `${LOG_PREFIX} Settlement failed: sendTransaction returned ${sendResult.status}.`,
              { hash: sendResult.hash, status: sendResult.status },
            )
          }

          // Attach the tx hash to the already-claimed challenge entry.
          await store.put(challengeStoreKey, {
            state: 'pending',
            hash: sendResult.hash,
            claimedAt: new Date().toISOString(),
          })

          try {
            await pollTransaction(rpcServer, sendResult.hash, {
              maxAttempts: pollMaxAttempts,
              delayMs: pollDelayMs,
              timeoutMs: pollTimeoutMs,
              semaphore: pollSemaphore,
            })
          } catch (error) {
            throw new SettlementError(
              `${LOG_PREFIX} Settlement status is ambiguous — challenge locked pending reconciliation.`,
              {
                hash: sendResult.hash,
                details: error instanceof Error ? error.message : String(error),
              },
            )
          }

          await store.put(challengeStoreKey, {
            state: 'settled',
            hash: sendResult.hash,
            settledAt: new Date().toISOString(),
          })
          await store.put(hashKey, { state: 'used', usedAt: new Date().toISOString() })

          return Receipt.from({
            method: 'stellar',
            reference: sendResult.hash,
            status: 'success',
            timestamp: new Date().toISOString(),
            ...(externalId ? { externalId } : {}),
          })
        } catch (error) {
          if (!mayBeOnChain) {
            // The transaction never reached the ledger, so release the claims
            // this call made. The payer can then retry the same challenge
            // instead of being permanently locked out by a failed settlement.
            await store.delete(challengeStoreKey)
            if (hashClaimedByUs && hashKey) {
              await store.delete(hashKey)
            }
          }
          throw error
        }
      }

      default:
        throw new PaymentVerificationError(
          `Unsupported credential type "${(payload as { type: string }).type}".`,
        )
    }
  }

  // ── Simulation validation ─────────────────────────────────────────────

  /**
   * Simulates the transaction via Soroban RPC and returns the successful response.
   *
   * @throws {PaymentVerificationError} If the simulation fails with a contract error.
   * @throws {PaymentVerificationError} If the simulation returns no events.
   */
  async function simulateTransfer(
    tx: Transaction,
    options: { authMode?: rpc.Api.SimulationAuthMode } = {},
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    let simResponse: rpc.Api.SimulateTransactionSuccessResponse
    try {
      simResponse = await simulateCall(rpcServer, tx, {
        timeoutMs: simulationTimeoutMs,
        authMode: options.authMode,
      })
    } catch (error) {
      if (error instanceof SimulationContractError) {
        throw new PaymentVerificationError(
          `${LOG_PREFIX} Pre-submission simulation failed: ${error.simulationError}`,
          { simulationError: error.simulationError },
        )
      }
      // Timeout and network errors bubble up as-is
      throw error
    }

    if (!simResponse.events || simResponse.events.length === 0) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Simulation produced no transfer events — cannot verify transfer.`,
        {},
      )
    }

    return simResponse
  }

  // ── Auth entry validation (sponsored path) ────────────────────────────

  /**
   * Validates Soroban authorization entries in the sponsored transaction.
   *
   * Ensures all auth entries use address credentials (not source-account),
   * none reference the server's address, none contain sub-invocations, and
   * expiration ledgers do not exceed the challenge's lifetime.
   *
   * @throws {PaymentVerificationError} If any auth entry violates these constraints.
   */
  async function validateAuthEntries(
    tx: Transaction,
    serverPublicKey: string,
    expiresTimestamp: number | undefined,
    expectedTransfer: { currency: string; from: string; to: string; amount: bigint },
  ) {
    const envelope = tx.toEnvelope().v1().tx()
    const ops = envelope.operations()

    // The latest ledger bounds auth-entry expirations on both ends. Fetch it
    // lazily and once, only when there is something to check.
    let latestLedgerSeq: number | undefined
    const getLatestLedgerSeq = async (): Promise<number> => {
      if (latestLedgerSeq === undefined) {
        latestLedgerSeq = (await rpcServer.getLatestLedger()).sequence
      }
      return latestLedgerSeq
    }

    // Upper bound on auth-entry expiration derived from the challenge lifetime.
    let maxLedger: number | undefined
    if (expiresTimestamp) {
      const nowSecs = Math.floor(Date.now() / 1000)
      const secsUntilExpiry = expiresTimestamp - nowSecs
      if (secsUntilExpiry <= 0) {
        throw new PaymentVerificationError(`${LOG_PREFIX} Challenge has expired.`, {
          expiresTimestamp,
          nowSecs,
        })
      }
      maxLedger =
        (await getLatestLedgerSeq()) +
        Math.ceil(secsUntilExpiry / DEFAULT_LEDGER_CLOSE_TIME) +
        AUTH_EXPIRATION_LEDGER_SKEW
    }

    const serverAddress = Address.fromString(serverPublicKey)

    for (let i = 0; i < ops.length; i++) {
      const opBody = ops[i].body()
      if (opBody.switch().value !== xdr.OperationType.invokeHostFunction().value) {
        throw new PaymentVerificationError(
          `${LOG_PREFIX} All operations must be invokeHostFunction in sponsored path.`,
          { operationType: opBody.switch().name },
        )
      }

      const authEntries = opBody.invokeHostFunctionOp().auth()
      // The transfer requires authorization from its `from` account; track that
      // at least one valid entry actually authorizes this exact transfer.
      // Otherwise a structurally valid but unrelated (or absent) entry would let
      // the server broadcast a transfer doomed to fail apply-time require_auth,
      // wasting the fee it paid to settle it.
      let transferAuthorized = false
      for (const entry of authEntries) {
        const credentials = entry.credentials()

        // Reject non-address credential types — only sorobanCredentialsAddress is
        // permitted. Source-account credentials would be implicitly authorized by the
        // server's envelope signature, allowing the client to piggyback operations.
        if (
          credentials.switch().value !==
          xdr.SorobanCredentialsType.sorobanCredentialsAddress().value
        ) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Only address-type auth entries are permitted.`,
            { credentialType: credentials.switch().name },
          )
        }

        const addressCred = credentials.address()

        const entryAddress = Address.fromScAddress(addressCred.address())
        if (entryAddress.toString() === serverAddress.toString()) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Server address must not appear in client auth entries.`,
            { serverAddress: serverPublicKey },
          )
        }

        const entryExpiration = addressCred.signatureExpirationLedger()
        const latestLedger = await getLatestLedgerSeq()
        if (entryExpiration <= latestLedger) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Auth entry signature has already expired (or expires at the current ledger).`,
            {
              entryExpiration,
              latestLedger,
            },
          )
        }
        if (maxLedger !== undefined && entryExpiration > maxLedger) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Auth entry expiration exceeds maximum allowed ledger.`,
            {
              entryExpiration,
              maxLedger,
            },
          )
        }

        const rootInvocation = entry.rootInvocation()
        if (rootInvocation.subInvocations().length > 0) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Auth entries must not contain sub-invocations.`,
            {},
          )
        }

        // Verify the authorization signature itself. Soroban RPC simulation
        // runs in recording mode and never checks it, so without this a
        // counterparty could supply a correctly-shaped but invalidly signed
        // entry; the server would broadcast a transfer that fails require_auth
        // on-chain and waste the fee it paid to settle it.
        try {
          verifyAuthEntrySignature(entry, networkPassphrase)
        } catch (error) {
          throw new PaymentVerificationError(`${LOG_PREFIX} Auth entry signature is invalid.`, {
            details: error instanceof Error ? error.message : String(error),
          })
        }

        // Bind the entry to the settled transfer: its authorizer must be the
        // transfer's `from` and its invocation must be exactly this transfer.
        if (
          entryAddress.toString() === expectedTransfer.from &&
          authorizationCoversTransfer(rootInvocation, expectedTransfer)
        ) {
          transferAuthorized = true
        }
      }

      if (!transferAuthorized) {
        throw new PaymentVerificationError(
          `${LOG_PREFIX} No authorization entry authorizes the requested transfer.`,
          {},
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/**
 * Returns whether an authorization entry's root invocation is exactly the
 * expected SEP-41 `transfer` — same token contract, function name, and
 * `(from, to, amount)` arguments. Used to confirm a sponsored auth entry
 * authorizes the transfer actually being settled, not some other call.
 */
function authorizationCoversTransfer(
  rootInvocation: xdr.SorobanAuthorizedInvocation,
  expected: { currency: string; from: string; to: string; amount: bigint },
): boolean {
  const authorizedFunction = rootInvocation.function()
  if (
    authorizedFunction.switch().value !==
    xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value
  ) {
    return false
  }
  const invokeArgs = authorizedFunction.contractFn()
  if (Address.fromScAddress(invokeArgs.contractAddress()).toString() !== expected.currency) {
    return false
  }
  if (invokeArgs.functionName().toString() !== 'transfer') {
    return false
  }
  const args = invokeArgs.args()
  if (args.length !== 3) {
    return false
  }
  try {
    return (
      Address.fromScVal(args[0]).toString() === expected.from &&
      Address.fromScVal(args[1]).toString() === expected.to &&
      scValToBigInt(args[2]) === expected.amount
    )
  } catch {
    return false
  }
}

/**
 * Asserts the transaction contains exactly one operation, that it is an `invokeHostFunction`, and
 * that the host function type is a contract invocation. Rejects multi-operation transactions as a
 * defense-in-depth measure (Soroban protocol also enforces this).
 */
/**
 * Rejects transactions whose source account or operation source matches the server's envelope
 * signing address.
 *
 * This keeps the sponsored-signing account separate from the transaction and operation sources.
 */
function verifyNoSigningAddressInSources(tx: Transaction, signerKP: Keypair | undefined) {
  if (!signerKP) return

  const signerAddress = signerKP.publicKey()

  if (tx.source === signerAddress) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transaction source must not be a server signing address.`,
      {},
    )
  }

  for (const op of tx.operations) {
    if (op.source && op.source === signerAddress) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Operation source must not be a server signing address.`,
        {},
      )
    }
  }
}

/**
 * Validates that the transaction's single operation is a SEP-41 `transfer` contract invocation
 * matching the expected parameters.
 *
 * Calls {@link verifyInvokeContractOp} first to ensure the transaction contains exactly one
 * `invokeHostFunction` operation, then verifies contract address, function name, and argument values.
 *
 * @throws {PaymentVerificationError} On any mismatch — no silent skipping.
 */
function verifyTokenTransfer(
  tx: Transaction,
  expected: { amount: bigint; currency: string; recipient: string; from: string },
) {
  const { contractAddress, invokeArgs } = verifyInvokeContractOp(tx, LOG_PREFIX)

  if (contractAddress !== expected.currency) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Contract address does not match expected currency.`,
      { expected: expected.currency, actual: contractAddress },
    )
  }

  const functionName = invokeArgs.functionName().toString()
  if (functionName !== 'transfer') {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Function name must be "transfer", got "${functionName}".`,
      { functionName },
    )
  }

  const args = invokeArgs.args()
  if (args.length !== 3) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transfer function expects 3 arguments, got ${args.length}.`,
      { argCount: args.length },
    )
  }

  const fromAddress = Address.fromScVal(args[0]).toString()
  if (fromAddress !== expected.from) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transfer "from" does not match credential source.`,
      { expected: expected.from, actual: fromAddress },
    )
  }

  const toAddress = Address.fromScVal(args[1]).toString()
  if (toAddress !== expected.recipient) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transfer "to" does not match expected recipient.`,
      { expected: expected.recipient, actual: toAddress },
    )
  }

  const amountVal = scValToBigInt(args[2])
  if (amountVal !== expected.amount) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transfer amount does not match expected amount.`,
      { expected: expected.amount.toString(), actual: amountVal.toString() },
    )
  }
}

/**
 * Verifies an on-chain transaction result (push mode) contains a valid
 * SEP-41 `transfer` invocation matching the expected parameters.
 *
 * Parses the envelope XDR from the RPC response, then delegates to {@link verifyTokenTransfer}.
 *
 * Returns the **inner transaction hash** (hex) — the canonical identifier of the
 * on-chain value transfer. A `FeeBumpTransaction` exposes two distinct
 * on-chain-resolvable hashes (the inner tx hash and the outer fee-bump hash); the
 * inner hash uniquely identifies the payment and is the key both push and pull
 * modes dedup on, so the same payment can never settle twice under different hashes.
 */
function verifyTokenTransferFromResult(
  txResult: rpc.Api.GetSuccessfulTransactionResponse,
  expected: { amount: bigint; currency: string; recipient: string; from: string },
  networkPassphrase: string,
): string {
  if (!txResult.envelopeXdr) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Transaction result is missing envelope XDR — cannot verify payment.`,
      {},
    )
  }

  let envelope: xdr.TransactionEnvelope
  if (typeof txResult.envelopeXdr === 'string') {
    try {
      envelope = xdr.TransactionEnvelope.fromXDR(txResult.envelopeXdr, 'base64')
    } catch (error) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Could not parse transaction envelope for verification.`,
        {
          details: error instanceof Error ? error.message : String(error),
        },
      )
    }
  } else {
    envelope = txResult.envelopeXdr
  }

  let innerTx: Transaction
  try {
    const parsed = TransactionBuilder.fromXDR(envelope.toXDR('base64'), networkPassphrase)
    innerTx =
      parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : (parsed as Transaction)
  } catch {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Could not parse transaction envelope for verification.`,
      {},
    )
  }

  verifyTokenTransfer(innerTx, expected)

  return innerTx.hash().toString('hex')
}

// ---------------------------------------------------------------------------
// Simulation event validation (CAP-46 transfer events)
// ---------------------------------------------------------------------------

/**
 * Parses CAP-46 diagnostic events from a Soroban simulation and validates
 * that exactly one `transfer` event was emitted with the correct parameters.
 *
 * Also ensures the server's address is not the sender in any transfer event,
 * preventing the server from paying itself.
 *
 * @throws {PaymentVerificationError} If no transfer events are found, more
 *   than one is found, parameters don't match, or the server address appears.
 */
function validateSimulationEvents(
  events: xdr.DiagnosticEvent[],
  expected: {
    amount: bigint
    currency: string
    recipient: string
    from: string
    serverAddress: string | undefined
  },
) {
  const transferEvents: Array<{ from: string; to: string; amount: bigint; contract: string }> = []

  for (const event of events) {
    const contractEvent = event.event()
    // Only process contract events — skip system and diagnostic events
    if (contractEvent.type().name !== 'contract') continue

    const body = contractEvent.body().v0()
    const topics = body.topics()
    if (topics.length < 3) continue

    // CAP-46: topic[0] = "transfer"
    const topicName = topics[0].sym?.()?.toString()
    if (topicName !== 'transfer') continue

    const from = Address.fromScVal(topics[1]).toString()
    const to = Address.fromScVal(topics[2]).toString()
    const amount = scValToBigInt(body.data())
    const contractId = contractEvent.contractId()
    if (!contractId) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Transfer event is missing contract ID — cannot verify source contract.`,
        {},
      )
    }
    const contract = Address.fromScAddress(
      xdr.ScAddress.scAddressTypeContract(contractId),
    ).toString()

    transferEvents.push({ from, to, amount, contract })
  }

  if (transferEvents.length === 0) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Simulation produced no transfer events — cannot verify transfer.`,
      {},
    )
  }

  // Spec: "events MUST show only expected balance changes; any other balance
  // change fails verification." Reject if there are unexpected transfers.
  if (transferEvents.length !== 1) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Simulation produced ${transferEvents.length} transfer events; expected exactly 1.`,
      { count: transferEvents.length },
    )
  }

  // Server's signing key must not be the sender in any transfer — check before parameter
  // matching so the error message is specific rather than a generic "does not match".
  if (expected.serverAddress) {
    const serverIsSender = transferEvents.some((t) => t.from === expected.serverAddress)
    if (serverIsSender) {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Server signing address must not be the sender in transfer events.`,
        { serverAddress: expected.serverAddress },
      )
    }
  }

  const transfer = transferEvents[0]
  if (
    transfer.to !== expected.recipient ||
    transfer.amount !== expected.amount ||
    transfer.contract !== expected.currency ||
    transfer.from !== expected.from
  ) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Simulation transfer event does not match expected parameters.`,
      {
        expectedRecipient: expected.recipient,
        expectedAmount: expected.amount.toString(),
        expectedCurrency: expected.currency,
        expectedFrom: expected.from,
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the Stellar public key from a `did:pkh` DID string.
 *
 * Format: `did:pkh:stellar:{network}:{G...publicKey}`
 *
 * Throws `PaymentVerificationError` if the source is absent, not a string,
 * or does not conform to the expected `did:pkh` format. A credential without
 * a verifiable source must be rejected because the payer account cannot be
 * matched to the credential.
 */
function publicKeyFromDID(source: unknown): string {
  if (typeof source !== 'string' || !source) {
    throw new PaymentVerificationError(
      `${LOG_PREFIX} Credential source is required to verify the sender address.`,
      {},
    )
  }
  const parts = source.split(':')
  // did : pkh : stellar : {network} : {pubkey}
  if (
    parts.length === 5 &&
    parts[0] === 'did' &&
    parts[1] === 'pkh' &&
    parts[2] === 'stellar' &&
    parts[3] // non-empty network
  ) {
    const pubKey = parts[4]
    try {
      Keypair.fromPublicKey(pubKey)
    } catch {
      throw new PaymentVerificationError(
        `${LOG_PREFIX} Credential source contains an invalid Stellar public key.`,
        { source },
      )
    }
    return pubKey
  }
  throw new PaymentVerificationError(
    `${LOG_PREFIX} Credential source has invalid format — expected did:pkh:stellar:{network}:{pubkey}.`,
    { source },
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export declare namespace charge {
  type Parameters = {
    /** Recipient Stellar public key (G…) or contract address (C…). */
    recipient: string
    /**
     * SEP-41 token contract address (C…) for the asset to transfer.
     *
     * This is the Soroban contract ID of the token, not the classic asset code.
     * For SAC-wrapped native assets use the corresponding SAC address, e.g.
     * `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` for XLM
     * on testnet.
     */
    currency: string
    /** Number of decimal places for amount conversion. @defaultValue `7` */
    decimals?: number
    /** CAIP-2 network identifier. @defaultValue `"stellar:testnet"` */
    network?: NetworkId
    /**
     * Soroban RPC endpoint URL.
     *
     * @defaultValue `"https://soroban-testnet.stellar.org"` (testnet) or
     *   `"https://soroban-rpc.mainnet.stellar.gateway.fm"` (pubnet)
     */
    rpcUrl?: string
    /**
     * Server-sponsored fee configuration.
     *
     * When set, the challenge includes `methodDetails.feePayer: true` which
     * tells the client to use pull mode with an all-zeros placeholder source.
     * The server rebuilds the transaction with its own account and signs the
     * envelope.
     */
    feePayer?: {
      /** Keypair providing the source account and envelope signature. */
      envelopeSigner: Keypair | string
      /** Optional fee bump signer — wraps the sponsored tx in a FeeBumpTransaction. */
      feeBumpSigner?: Keypair | string
    }
    /**
     * Replay protection store for challenge and tx hash deduplication.
     *
     * Required — all replay protection depends on this store. Without it,
     * a confirmed payment could be accepted more than once.
     *
     * `update()` must be a **linearizable compare-and-set**: the callback must
     * observe the latest committed value and its write must commit (or abort) as
     * one indivisible step, even under concurrent callers across processes. The
     * constructor verifies that `update()` exists but cannot verify that the
     * backend implements it correctly — a store that emulates `update()` with a
     * separate get-then-put, or one backed by an eventually-consistent datastore,
     * passes the type check while silently dropping the guarantee in multi-process
     * deployments.
     *
     * Reference implementations:
     * - Single process: `Store.memory()`.
     * - Multi-process (e.g. multiple pods behind a load balancer): a single shared
     *   backend whose `update()` maps to a genuine atomic CAS, such as a Redis Lua
     *   script or a PostgreSQL conditional `UPDATE … WHERE`. A per-instance
     *   `Store.memory()` or a plain get-then-put against a shared cache is not
     *   sufficient.
     */
    store: Store.AtomicStore
    /** Maximum fee in stroops for the inner transaction and fee bump. @defaultValue `10_000_000` (1 XLM) */
    maxFeeBumpStroops?: number
    /** Maximum number of polling attempts when waiting for tx confirmation. @defaultValue `20` */
    pollMaxAttempts?: number
    /** Maximum concurrent polling operations for this server instance. @defaultValue `10` */
    pollMaxConcurrent?: number
    /** Base delay between polling attempts in milliseconds. @defaultValue `1_000` */
    pollDelayMs?: number
    /** Overall timeout for transaction polling in milliseconds. @defaultValue `20_000` */
    pollTimeoutMs?: number
    /** Timeout for Soroban RPC simulation calls in milliseconds. @defaultValue `10_000` */
    simulationTimeoutMs?: number
    /**
     * Whether to accept legacy unsigned push-mode credentials (type="hash").
     *
     * Defaults to `false`: only the payer-authenticated `signedHash` push mode and
     * pull mode (`transaction`) are accepted. Legacy unsigned push relies solely on
     * the client-declared payer identity rather than a proof of control, so it is
     * not accepted by default.
     *
     * Set to `true` only for backward compatibility with pre-`signedHash` clients
     * mid-migration; each acceptance is logged so operators can track when the legacy
     * traffic drains and turn it back off. New deployments should leave it disabled.
     *
     * @defaultValue `false`
     */
    allowUnsignedPush?: boolean
    /**
     * Maximum age, in seconds, of an on-chain payment that push-mode settlement
     * (`signedHash`/`hash`) will accept, measured at verification time. Bounds how
     * far in the past a confirmed transfer may have been included, so a payment
     * made before the challenge cannot be presented as its settlement.
     *
     * @defaultValue `900`
     */
    maxPushPaymentAgeSeconds?: number
    /**
     * Lifetime, in seconds, of the challenges this server issues. Push-mode
     * settlement uses it to derive each challenge's issuance time from its
     * `expires` field and reject any on-chain payment confirmed before then, so a
     * transfer made before the challenge cannot be presented as its settlement.
     * Set this to match the expiry configured on the server's challenge issuer.
     *
     * @defaultValue `300`
     */
    challengeLifetimeSeconds?: number
    /** Logger instance (pino and console compatible API). Defaults to a no-op logger. */
    logger?: Logger
  }
}
