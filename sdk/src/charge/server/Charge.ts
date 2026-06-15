import {
  Account,
  Address,
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
import {
  DEFAULT_MAX_FEE_BUMP_STROOPS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_MAX_CONCURRENT,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SIMULATION_TIMEOUT_MS,
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

        // Tx hash dedup via atomic compare-and-set: reject if hash already used.
        const hashKey = `${STORE_PREFIX}:hash:${hash}`
        const hashReplayError = new PaymentVerificationError(
          `${LOG_PREFIX} Transaction hash already used. Replay rejected.`,
          { hash },
        )
        const hashClaimId = crypto.randomUUID()
        const hashClaimResult = await store.update(hashKey, (current) =>
          current
            ? { op: 'noop', result: 'replay' as const }
            : {
                op: 'set',
                value: {
                  state: 'pending',
                  claimId: hashClaimId,
                  claimedAt: new Date().toISOString(),
                },
                result: 'claimed' as const,
              },
        )
        if (hashClaimResult === 'replay') {
          logger.warn(`${LOG_PREFIX} Verification failed`, {
            error: 'Transaction hash already used',
            hash,
          })
          throw hashReplayError
        }

        try {
          // Push mode requires the transaction to be confirmed on-chain
          // before the client submits the hash.
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

          // Extract the payer's public key from the credential DID to verify
          // the on-chain transfer's `from` address matches the credential's
          // claimed payer identity.
          const expectedFrom = publicKeyFromDID(source)
          verifyTokenTransferFromResult(
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
          // The signature must be over "{challenge.id}:{hash}" (lowercase hash).
          // This binds the credential to both the challenge and the canonical tx hash,
          // so the claimed source must control the payer account used by the payment.
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
        } catch (err) {
          await store.update(hashKey, (current) => {
            if (
              current &&
              typeof current === 'object' &&
              'state' in current &&
              (current as { state?: string }).state === 'pending' &&
              'claimId' in current &&
              (current as { claimId?: string }).claimId === hashClaimId
            ) {
              return { op: 'delete', result: undefined }
            }
            return { op: 'noop', result: undefined }
          })
          throw err
        }

        // Finalize claims after successful verification
        await store.put(`${STORE_PREFIX}:hash:${hash}`, {
          state: 'used',
          usedAt: new Date().toISOString(),
        })
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

        // Tx hash dedup via atomic compare-and-set: reject if hash already used.
        const hashKey = `${STORE_PREFIX}:hash:${hash}`
        const hashReplayError = new PaymentVerificationError(
          `${LOG_PREFIX} Transaction hash already used. Replay rejected.`,
          { hash },
        )
        const hashClaimId = crypto.randomUUID()
        const hashClaimResult = await store.update(hashKey, (current) =>
          current
            ? { op: 'noop', result: 'replay' as const }
            : {
                op: 'set',
                value: {
                  state: 'pending',
                  claimId: hashClaimId,
                  claimedAt: new Date().toISOString(),
                },
                result: 'claimed' as const,
              },
        )
        if (hashClaimResult === 'replay') {
          logger.warn(`${LOG_PREFIX} Verification failed`, {
            error: 'Transaction hash already used',
            hash,
          })
          throw hashReplayError
        }

        try {
          // Push mode requires the transaction to be confirmed on-chain
          // before the client submits the hash.
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

          // Extract the payer's public key from the credential DID to verify
          // the on-chain transfer's `from` address matches the credential's
          // claimed payer identity.
          const expectedFrom = publicKeyFromDID(source)
          verifyTokenTransferFromResult(
            txResult,
            {
              amount: expectedAmount,
              currency: expectedCurrency,
              recipient: expectedRecipient,
              from: expectedFrom,
            },
            networkPassphrase,
          )

          // Note: Legacy hash type does not verify sourceSignature.
          // For source signature verification, use type="signedHash".
        } catch (err) {
          await store.update(hashKey, (current) => {
            if (
              current &&
              typeof current === 'object' &&
              'state' in current &&
              (current as { state?: string }).state === 'pending' &&
              'claimId' in current &&
              (current as { claimId?: string }).claimId === hashClaimId
            ) {
              return { op: 'delete', result: undefined }
            }
            return { op: 'noop', result: undefined }
          })
          throw err
        }

        // Log acceptance of legacy unsigned push for operator visibility
        logger.warn(`${LOG_PREFIX} Accepting unsigned push (legacy mode)`, {
          challengeId: challenge.id,
          hash,
        })

        // Finalize claims after successful verification
        await store.put(`${STORE_PREFIX}:hash:${hash}`, {
          state: 'used',
          usedAt: new Date().toISOString(),
        })
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

          await validateAuthEntries(tx, envelopeKP.publicKey(), expiresTimestamp)

          // Rebuild the tx with the signer's account as source
          logger.debug(`${LOG_PREFIX} Rebuilding sponsored tx...`)
          const serverAccount = await rpcServer.getAccount(envelopeKP.publicKey())
          const originalSeq = serverAccount.sequenceNumber() // needed because Transaction.build sets sequence to account's current + 1 in place.
          const envelopeTx = tx.toEnvelope().v1().tx()
          const rawOp = envelopeTx.operations()[0]

          // Build without sorobanData so simulation determines resources.
          // This consumes the account's sequence (N → N+1).
          const simBuilder = new TransactionBuilder(serverAccount, {
            fee: Math.min(Number(tx.fee), maxFeeBumpStroops).toString(),
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
          const simResponse = await simulateTransfer(rebuiltTx)
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
            fee: Math.min(Number(tx.fee), maxFeeBumpStroops).toString(),
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

        // Tx hash dedup via atomic compare-and-set, just before broadcast:
        // settle each transaction at most once (shared with push-mode hashes).
        const txHash = tx.hash().toString('hex')
        const hashKey = `${STORE_PREFIX}:hash:${txHash}`
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
          throw new SettlementError(
            `${LOG_PREFIX} Settlement failed: could not broadcast transaction.`,
            {
              details: error instanceof Error ? error.message : String(error),
            },
          )
        }

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
  ): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
    let simResponse: rpc.Api.SimulateTransactionSuccessResponse
    try {
      simResponse = await simulateCall(rpcServer, tx, { timeoutMs: simulationTimeoutMs })
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
  ) {
    const envelope = tx.toEnvelope().v1().tx()
    const ops = envelope.operations()

    // Calculate max ledger from expires
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
      const latestLedger = await rpcServer.getLatestLedger()
      maxLedger = latestLedger.sequence + Math.ceil(secsUntilExpiry / DEFAULT_LEDGER_CLOSE_TIME)
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

        if (maxLedger !== undefined) {
          const entryExpiration = addressCred.signatureExpirationLedger()
          if (entryExpiration > maxLedger) {
            throw new PaymentVerificationError(
              `${LOG_PREFIX} Auth entry expiration exceeds maximum allowed ledger.`,
              {
                entryExpiration,
                maxLedger,
              },
            )
          }
        }

        const rootInvocation = entry.rootInvocation()
        if (rootInvocation.subInvocations().length > 0) {
          throw new PaymentVerificationError(
            `${LOG_PREFIX} Auth entries must not contain sub-invocations.`,
            {},
          )
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

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
 */
function verifyTokenTransferFromResult(
  txResult: rpc.Api.GetSuccessfulTransactionResponse,
  expected: { amount: bigint; currency: string; recipient: string; from: string },
  networkPassphrase: string,
) {
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
    /** Logger instance (pino and console compatible API). Defaults to a no-op logger. */
    logger?: Logger
  }
}
