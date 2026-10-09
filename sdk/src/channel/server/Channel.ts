import {
  Contract,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { Method, Receipt, Store } from 'mppx'
import {
  DEFAULT_DECIMALS,
  DEFAULT_FEE,
  DEFAULT_TIMEOUT,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
  type NetworkId,
} from '../../constants.js'
import {
  DEFAULT_MAX_CLOSE_SENDS,
  DEFAULT_MAX_FEE_BUMP_STROOPS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONCURRENT,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_VERIFY_MAX_CONCURRENT,
  DEFAULT_SIMULATION_TIMEOUT_MS,
} from '../../shared/defaults.js'
import { Semaphore } from '../../shared/semaphore.js'
import { ChannelVerificationError, SettlementError } from '../../shared/errors.js'
import { wrapFeeBump } from '../../shared/fee-bump.js'
import { resolveKeypair } from '../../shared/keypairs.js'
import { noopLogger, type Logger } from '../../shared/logger.js'
import { pollTransaction, TransactionFailedError } from '../../shared/poll.js'
import { toBaseUnits } from '../../shared/units.js'
import {
  validateAmount,
  validateContractAddress,
  validateHexSignature,
} from '../../shared/validation.js'
import { verifyInvokeContractOp } from '../../shared/verify-invoke.js'
import { buildCommitmentMessage } from '../commitment.js'
import { channel as ChannelMethod } from '../Methods.js'
import { getChannelState, type ChannelState } from './State.js'

type ChannelCredential = Parameters<Method.VerifyFn<typeof ChannelMethod>>[0]['credential']

/**
 * The channel's cumulative record: the latest accepted commitment and, once a
 * close has been selected, the permanent `closing` latch.
 */
type CumulativeRecord = {
  amount: string
  /** Hex ed25519 commitment signature for `amount`; absent on records written by earlier versions. */
  signature?: string
  /**
   * Set once a close has been accepted for this channel, in the same atomic
   * update that selects the commitment to close with. Never cleared: the
   * channel is ending, and completion is read from the chain, not the store.
   */
  closing?: true
  /** @deprecated Written by earlier versions; read as `closing`. */
  settling?: boolean
}

/**
 * Creates a Stellar one-way-channel method for use on the **server**.
 *
 * The server:
 * 1. Issues challenges with the channel contract address and cumulative amount
 * 2. Verifies commitment signatures against the channel's commitment key
 * 3. Optionally closes the channel and settles funds on-chain
 *
 * Closing is final. Once a close credential is accepted, or
 * {@link closeWithLatestCommitment} selects the stored commitment, the channel
 * stops accepting credentials for good. Whether the on-chain close has taken
 * effect is read from the chain (`withdrawn`), never inferred from a
 * transaction's outcome, and the contract's `close` pays only the amount not
 * yet withdrawn, so a close can be sent again at any time.
 *
 * @example
 * ```ts
 * import { stellar } from '@stellar/mpp/channel/server'
 * import { Mppx } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   secretKey: 'my-secret',
 *   methods: [
 *     stellar.channel({
 *       channel: 'C...',          // on-chain channel contract
 *       commitmentKey: 'GABC...', // ed25519 public key for verifying commitments
 *     }),
 *   ],
 * })
 * ```
 */
const LOG_PREFIX = '[stellar:channel]'
const STORE_PREFIX = 'stellar:channel'

/** Store key of a channel's cumulative record. */
function cumulativeStoreKey(channelAddress: string): string {
  return `${STORE_PREFIX}:cumulative:${channelAddress}`
}

function closedStoreKey(channelAddress: string): string {
  return `${STORE_PREFIX}:closed:${channelAddress}`
}

function closeSendsStoreKey(channelAddress: string): string {
  return `${STORE_PREFIX}:closeSends:${channelAddress}`
}

/** Whether a stored record carries the closing latch (or its legacy spelling). */
function isClosing(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false
  const { closing, settling } = record as CumulativeRecord
  return closing === true || settling === true
}

function closingError(channelAddress: string): ChannelVerificationError {
  return new ChannelVerificationError(
    `${LOG_PREFIX} Channel is closing — no further credentials accepted.`,
    { channel: channelAddress },
  )
}

/** Reads the cumulative amount from a stored record, treating an absent or
 * malformed record as a zero cumulative. */
function readCumulativeAmount(record: unknown): bigint {
  if (record && typeof record === 'object' && 'amount' in record) {
    return BigInt((record as CumulativeRecord).amount)
  }
  return 0n
}

/** Returns the error for a commitment that fails to advance the cumulative
 * (not strictly increasing, or not covering the requested amount), or null when
 * the commitment is valid. Shared by the pre-RPC short-circuit and the
 * authoritative atomic update so both apply identical rules. */
function cumulativeMonotonicityError(
  previousCumulative: bigint,
  commitmentAmount: bigint,
  requestedAmount: bigint,
): ChannelVerificationError | null {
  if (commitmentAmount <= previousCumulative) {
    return new ChannelVerificationError(
      `${LOG_PREFIX} Commitment amount ${commitmentAmount} must be greater than previous cumulative ${previousCumulative}.`,
      {
        commitmentAmount: commitmentAmount.toString(),
        previousCumulative: previousCumulative.toString(),
      },
    )
  }
  if (commitmentAmount < previousCumulative + requestedAmount) {
    return new ChannelVerificationError(
      `${LOG_PREFIX} Commitment amount ${commitmentAmount} does not cover the requested amount ${requestedAmount} (previous cumulative: ${previousCumulative}).`,
      {
        commitmentAmount: commitmentAmount.toString(),
        requestedAmount: requestedAmount.toString(),
        previousCumulative: previousCumulative.toString(),
      },
    )
  }
  return null
}

export function channel(parameters: channel.Parameters) {
  if (!parameters.store) {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} A store is required for channel mode. Provide a Store instance for replay protection, cumulative tracking, and channel lifecycle state.`,
      {},
    )
  }

  if (typeof parameters.store.update !== 'function') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} An atomic store providing compare-and-set semantics via update() is required for replay protection.`,
      {},
    )
  }

  const {
    channel: channelAddress,
    checkOnChainState = true,
    commitmentKey: commitmentKeyParam,
    decimals = DEFAULT_DECIMALS,
    feePayer,
    maxFeeBumpStroops = DEFAULT_MAX_FEE_BUMP_STROOPS,
    network = STELLAR_TESTNET,
    onDisputeDetected,
    recipient,
    currency,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollMaxConcurrent = DEFAULT_POLL_MAX_CONCURRENT,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    rpcUrl,
    verifyMaxConcurrent = DEFAULT_VERIFY_MAX_CONCURRENT,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
    store,
    feeBudget,
    logger = noopLogger,
  } = parameters

  // Fail fast on a misconfigured channel address
  validateContractAddress(channelAddress)

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const networkPassphrase = NETWORK_PASSPHRASE[network]
  const rpcServer = new rpc.Server(resolvedRpcUrl)
  const pollSemaphore = new Semaphore(pollMaxConcurrent)
  // Limits the number of credential verifications that hold an on-chain state
  // read at the same time. The reads run outside cumulativeLock, so this
  // semaphore is the only limit on concurrent RPC calls.
  const verifySemaphore = new Semaphore(verifyMaxConcurrent)

  // Parse the commitment public key (accepts G... Stellar public key string or Keypair)
  const commitmentKP = (() => {
    if (typeof commitmentKeyParam === 'string') {
      return Keypair.fromPublicKey(commitmentKeyParam)
    }
    return commitmentKeyParam
  })()

  const envelopeKP = feePayer ? resolveKeypair(feePayer.envelopeSigner) : undefined
  const feeBumpKP = feePayer?.feeBumpSigner ? resolveKeypair(feePayer.feeBumpSigner) : undefined

  // Track cumulative amounts per channel in the store
  const cumulativeKey = cumulativeStoreKey(channelAddress)

  // Serialize cumulative amount updates to prevent concurrent double-acceptance.
  // Without a transactional store, two concurrent verify calls could both
  // read the same cumulative amount, both pass, and only one write wins.
  // Only the validation+write phase runs under the lock — long operations
  // like on-chain broadcasts run outside to prevent head-of-line blocking.
  let cumulativeLock: Promise<unknown> = Promise.resolve()

  if (!checkOnChainState) {
    logger.warn(
      `${LOG_PREFIX} checkOnChainState is disabled — the server will not detect external channel closes. Vouchers accepted after an external close cannot be settled.`,
    )
  } else {
    if (!recipient) {
      logger.warn(
        `${LOG_PREFIX} No recipient configured — the channel's on-chain payout address is not verified. Set recipient to the account that should receive close payouts so a channel paying out elsewhere is rejected.`,
      )
    }
    if (!currency) {
      logger.warn(
        `${LOG_PREFIX} No currency configured — the channel's on-chain token is not verified. Set currency to the token contract you expect so a channel paying out a different token is rejected.`,
      )
    }
  }

  if (feeBumpKP && !feeBudget) {
    logger.warn(
      `${LOG_PREFIX} A fee-bump signer is configured without a feeBudget — sponsor fee spending per funder is not capped. Set feeBudget to bound settlement fee usage in fee-sponsoring deployments.`,
    )
  }

  logger.info(
    `${LOG_PREFIX} Initialized. Multi-process deployments require an atomic store.update() compare-and-set implementation for replay protection.`,
  )

  return Method.toServer(ChannelMethod, {
    defaults: {
      channel: channelAddress,
    },
    async request({ request }) {
      // Retrieve current cumulative amount from store
      let currentCumulative = '0'
      const stored = await store.get(cumulativeKey)
      if (stored && typeof stored === 'object' && 'amount' in stored) {
        currentCumulative = (stored as { amount: string }).amount
      }

      return {
        ...request,
        amount: toBaseUnits(request.amount, decimals),
        methodDetails: {
          ...request.methodDetails,
          reference: crypto.randomUUID(),
          network,
          cumulativeAmount: currentCumulative,
        },
      }
    },
    async verify({ credential }) {
      // Phase 1a: format checks, replay claim, and RPC — outside the lock.
      // Phase 1b: authoritative cumulative write — under the lock, store only.
      // Phase 2: broadcast and poll for a close — outside the lock.
      const prepared = await doPrepare(credential)
      const validated = await withCumulativeLock(() => doCommit(prepared))
      return doSettle(validated)
    },
  })

  /** Output of {@link doPrepare}: everything {@link doCommit} needs to write
   *  channel state without re-reading the credential. */
  type PreparedCredential = {
    action: 'voucher' | 'close'
    commitmentAmount: bigint
    requestedAmount: bigint
    signatureBytes: Buffer
    challengeStoreKey: string
    challengeReference: string
    externalId?: string
  }

  type ValidatedCredential =
    | { action: 'voucher'; receipt: Receipt.Receipt }
    | {
        action: 'close'
        commitmentAmount: bigint
        signatureBytes: Buffer
        challengeStoreKey: string
        externalId?: string
      }

  /**
   * Serializes `fn` against every other holder of the cumulative lock.
   *
   * The same callback is passed to both `.then` arms so a rejected predecessor
   * does not poison the chain — without the second arm, one failed validation
   * would leave `cumulativeLock` permanently rejected and every later caller
   * would skip its turn.
   */
  function withCumulativeLock<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      cumulativeLock = cumulativeLock.then(
        () => fn().then(resolve, reject),
        () => fn().then(resolve, reject),
      )
    })
  }

  /**
   * Rejects credentials once a close has been confirmed for this channel.
   *
   * Read by both phases: {@link doPrepare} rejects early to avoid spending RPC,
   * and {@link doCommit} re-reads because an RPC round-trip has elapsed since.
   */
  async function assertNotClosed(): Promise<void> {
    const closed = await store.get(closedStoreKey(channelAddress))
    if (closed) {
      logger.warn(`${LOG_PREFIX} Rejecting credential — channel already closed`, {
        channel: channelAddress,
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel has been closed. No further credentials accepted.`,
        { channel: channelAddress },
      )
    }
  }

  /**
   * Phase 1a: checks and RPC. This function runs OUTSIDE {@link cumulativeLock}.
   *
   * The function claims the challenge, validates the formats and proves that
   * the commitment signature is authentic. The signature check is local and
   * makes no RPC call. The function writes no channel state, except for the
   * self-synchronising challenge claim.
   *
   * The lifecycle reads here are therefore advisory. They reject an invalid
   * credential early, before the server makes an RPC call. {@link doCommit}
   * makes the authoritative checks under the lock.
   *
   * The remaining RPC call stays outside the lock for a reason. The on-chain
   * state query costs several calls, and `simulationTimeoutMs` (default 10s)
   * bounds its simulation. If the server held the lock during that query, one
   * credential could stop every other payer on this channel.
   */
  async function doPrepare(credential: ChannelCredential): Promise<PreparedCredential> {
    const { challenge, payload } = credential
    const { request: challengeRequest } = challenge

    const action = payload.action ?? 'voucher'
    const { externalId } = challengeRequest

    // Advisory lifecycle reads — re-checked authoritatively in doCommit.
    await assertNotClosed()

    // Reject all actions once a close has been selected for this channel. The
    // closing latch is set atomically with the commitment it closes with and is
    // never cleared, so no credential accepted afterwards could go uncovered.
    const cumulativeRecord = await store.get(cumulativeKey)
    if (isClosing(cumulativeRecord)) {
      logger.warn(`${LOG_PREFIX} Rejecting credential — channel is closing`, {
        channel: channelAddress,
      })
      throw closingError(channelAddress)
    }

    // Replay protection via atomic compare-and-set: reject if challenge already used.
    // Applied to all actions. Self-synchronising, so it needs no lock — and it runs
    // ahead of the RPC below so replayed challenges are shed without a round-trip.
    const challengeStoreKey = `${STORE_PREFIX}:challenge:${challenge.id}`
    const replayError = new ChannelVerificationError('Challenge already used. Replay rejected.', {
      channel: channelAddress,
    })
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
      throw replayError
    }

    validateAmount(payload.amount)
    const commitmentAmount = BigInt(payload.amount)
    const signatureHex = payload.signature

    // Validate hex signature format
    try {
      validateHexSignature(signatureHex)
    } catch (err) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} ${err instanceof Error ? err.message : 'Invalid signature'}`,
        { signature: signatureHex, length: String(signatureHex?.length ?? 0) },
      )
    }
    const signatureBytes = Buffer.from(signatureHex, 'hex')

    validateAmount(challengeRequest.amount)
    const requestedAmount = BigInt(challengeRequest.amount)

    // Cheap monotonicity short-circuit before any RPC work: a commitment that
    // cannot advance the cumulative is rejected here, so a flood of stale or
    // non-monotonic commitments cannot amplify into signature-verify and
    // on-chain-state RPC load. The atomic store.update in doCommit stays
    // authoritative, re-reading the latest cumulative to remain correct under
    // concurrent writes.
    const preCheckError = cumulativeMonotonicityError(
      readCumulativeAmount(cumulativeRecord),
      commitmentAmount,
      requestedAmount,
    )
    if (preCheckError) {
      throw preCheckError
    }

    // Verify the commitment signature before the server writes channel state.
    // This check is local and uses only the CPU, so it runs outside the
    // semaphore below. The server rejects a forged voucher before that voucher
    // can occupy one of the limited RPC slots.
    verifyCommitmentSignature(commitmentAmount, signatureBytes)

    // Read the on-chain state only after the signature check succeeds. The
    // state read costs several RPC calls. The cheap signature check runs first,
    // so a forged voucher cannot cause the full state query.
    //
    // Limit the concurrency here. The cumulative lock previously serialised
    // validation, so it allowed only one read at a time. These reads now run
    // outside that lock. Without this limit, a burst of credentials could send
    // many requests to the RPC provider at the same time.
    if (checkOnChainState) {
      await verifySemaphore.acquire()
      try {
        await verifyOnChainState(commitmentAmount)
      } finally {
        verifySemaphore.release()
      }
    }

    if (action === 'close') {
      // A close can only be settled by a server configured with an envelope
      // signer. Reject it before the cumulative update writes the closing
      // latch, so a voucher-only server is not bricked by a close it can never
      // complete.
      if (!envelopeKP) {
        throw new ChannelVerificationError(
          `${LOG_PREFIX} Close action requires a feePayer.envelopeSigner (transaction source and envelope signer) to be configured.`,
          {},
        )
      }
      // Likewise, a close the fee budget would refuse must not latch the
      // channel. This read-only check mirrors the charge taken before broadcast.
      assertFeeBudgetAvailable(await store.get(feeBudgetStoreKey()))
    }

    return {
      action,
      commitmentAmount,
      requestedAmount,
      signatureBytes,
      challengeStoreKey,
      challengeReference: challengeRequest.methodDetails?.reference ?? challenge.id,
      ...(externalId ? { externalId } : {}),
    }
  }

  /**
   * Phase 1b — authoritative state write (runs UNDER {@link cumulativeLock}).
   *
   * Holds the lock for store operations only: one atomic cumulative update.
   * For vouchers this returns the receipt directly; for a close it returns the
   * validated state so settlement can run outside the lock.
   */
  async function doCommit(prepared: PreparedCredential): Promise<ValidatedCredential> {
    const {
      action,
      commitmentAmount,
      requestedAmount,
      signatureBytes,
      challengeStoreKey,
      challengeReference,
      externalId,
    } = prepared

    // Re-read: an RPC round-trip elapsed inside doPrepare, so its lifecycle
    // reads may be seconds stale. The cumulative update below covers `closing`
    // (that latch lives in the cumulative record); `closed` is a separate key
    // and has to be re-read here.
    await assertNotClosed()

    // Atomic cumulative monotonic check and write: reject if invariants fail,
    // or write the new cumulative if all checks pass. A close credential sets
    // the closing latch in the same write, so every voucher is either covered
    // by the close or rejected.
    type CumulativeResult = { success: true } | { success: false; error: ChannelVerificationError }

    const cumulativeUpdateResult = await store.update(
      cumulativeKey,
      (current): Store.Change<CumulativeRecord, CumulativeResult> => {
        let previousCumulative = 0n
        if (current && typeof current === 'object' && 'amount' in current) {
          if (isClosing(current)) {
            return {
              op: 'noop',
              result: { success: false, error: closingError(channelAddress) },
            }
          }
          previousCumulative = BigInt((current as CumulativeRecord).amount)
        }

        // Authoritative monotonicity check against the latest stored cumulative,
        // applying the same rules as the pre-RPC short-circuit in doPrepare.
        const monotonicityError = cumulativeMonotonicityError(
          previousCumulative,
          commitmentAmount,
          requestedAmount,
        )
        if (monotonicityError) {
          return { op: 'noop', result: { success: false, error: monotonicityError } }
        }

        // All checks passed, write the new cumulative
        const record: CumulativeRecord = {
          amount: commitmentAmount.toString(),
          signature: signatureBytes.toString('hex'),
        }
        return {
          op: 'set',
          result: { success: true },
          value: action === 'close' ? { ...record, closing: true } : record,
        }
      },
    )

    if (!cumulativeUpdateResult.success) {
      throw cumulativeUpdateResult.error
    }

    if (action === 'close') {
      return {
        action: 'close',
        commitmentAmount,
        signatureBytes,
        challengeStoreKey,
        externalId,
      }
    }

    // Voucher path: cumulative was already written atomically above.
    // Mark the challenge as used and return receipt directly (no long operation).
    await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

    return {
      action: 'voucher',
      receipt: Receipt.from({
        method: 'stellar',
        reference: challengeReference,
        status: 'success',
        timestamp: new Date().toISOString(),
        ...(externalId ? { externalId } : {}),
      }),
    }
  }

  /**
   * Phase 2 — settlement (runs outside the lock).
   *
   * Handles long on-chain operations: broadcasting the close transaction
   * and polling for confirmation. Vouchers return directly from phase 1.
   */
  async function doSettle(validated: ValidatedCredential): Promise<Receipt.Receipt> {
    switch (validated.action) {
      case 'voucher':
        return validated.receipt
      case 'close':
        return doVerifyClose(validated)
    }
  }

  /**
   * Settles a channel close on-chain after a verified close credential.
   *
   * Steps:
   * 1. Ensures an `envelopeSigner` is configured (required for on-chain tx).
   * 2. Builds a `close(amount, signature)` contract invocation.
   * 3. Prepares the transaction via Soroban simulation and signs it.
   * 4. Optionally wraps in a FeeBumpTransaction when `feeBumpSigner` is set.
   * 5. Broadcasts and polls for on-chain confirmation.
   * 6. Marks the channel as closed and the challenge as used in the store.
   *
   * The closing latch written by {@link doCommit} stays whatever happens here.
   * If the close does not confirm, {@link closeWithLatestCommitment} completes
   * it later with the same stored commitment.
   *
   * @throws {ChannelVerificationError} If no envelopeSigner is configured.
   * @throws {SettlementError} If the broadcast fails or the on-chain tx does
   *   not confirm.
   */
  async function doVerifyClose(params: {
    commitmentAmount: bigint
    signatureBytes: Buffer
    challengeStoreKey: string
    externalId?: string
  }) {
    const { commitmentAmount, signatureBytes, challengeStoreKey, externalId } = params

    if (!envelopeKP) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Close action requires a feePayer.envelopeSigner (transaction source and envelope signer) to be configured.`,
        {},
      )
    }

    try {
      const contract = new Contract(channelAddress)
      const closeOp = contract.call(
        'close',
        nativeToScVal(commitmentAmount, { type: 'i128' }),
        nativeToScVal(Buffer.from(signatureBytes), { type: 'bytes' }),
      )

      const closeAccount = await rpcServer.getAccount(envelopeKP.publicKey())
      const closeTx = new TransactionBuilder(closeAccount, {
        fee: DEFAULT_FEE,
        networkPassphrase,
      })
        .addOperation(closeOp)
        .setTimeout(DEFAULT_TIMEOUT)
        .build()

      const prepared = await rpcServer.prepareTransaction(closeTx)
      assertPreparedCloseIsSafe(prepared, channelAddress)
      prepared.sign(envelopeKP)

      let txToSubmit: Transaction | FeeBumpTransaction = prepared
      if (feeBumpKP) {
        txToSubmit = wrapFeeBump(prepared, feeBumpKP, {
          networkPassphrase,
          maxFeeStroops: maxFeeBumpStroops,
        })
      }

      // Enforce fee budget before broadcast (fail-safe: charge BEFORE broadcast)
      await enforceFeeBudget()

      const txHash = await broadcastAndPoll(txToSubmit, 'Close')

      logger.debug(`${LOG_PREFIX} Channel closed, marking in store`)
      await store.put(closedStoreKey(channelAddress), {
        closedAt: new Date().toISOString(),
        txHash,
        amount: commitmentAmount.toString(),
      })

      await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

      return Receipt.from({
        method: 'stellar',
        reference: txHash,
        status: 'success',
        timestamp: new Date().toISOString(),
        ...(externalId ? { externalId } : {}),
      })
    } catch (error) {
      // mppx does not log payment errors, so surface settlement failures
      // through the configured logger. The channel stays closing; the close is
      // completed later by closeWithLatestCommitment.
      if (error instanceof SettlementError) {
        logger.error(error.message, error.details)
      }
      throw error
    }
  }

  /**
   * Builds the commitment message locally. Then verifies the ed25519 signature
   * against that message.
   *
   * An earlier version called `prepare_commitment` over RPC to get the signed
   * message. Four values fully determine the message: the amount, the
   * configured channel, the configured network and a constant domain
   * separator. The server knows all four values before the request arrives. The
   * call therefore added no information, and it cost up to
   * `simulationTimeoutMs` for each voucher.
   *
   * The local build also closes a security hole. Nothing authenticated the
   * simulation, so a hostile RPC could return the bytes for a smaller amount.
   * The server then checked the signature against those bytes, but it credited
   * the larger amount from the payload. Bytes from a local build always agree
   * with the amount that the server credits.
   *
   * @throws {ChannelVerificationError} If the signature does not match.
   */
  function verifyCommitmentSignature(commitmentAmount: bigint, signatureBytes: Buffer): void {
    logger.debug(`${LOG_PREFIX} Verifying commitment signature...`)
    const commitmentBytes = buildCommitmentMessage({
      channel: channelAddress,
      amount: commitmentAmount,
      network,
    })
    const valid = commitmentKP.verify(commitmentBytes, signatureBytes)

    if (!valid) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Commitment signature verification failed.`,
        {
          amount: commitmentAmount.toString(),
          channel: channelAddress,
        },
      )
    }
  }

  /**
   * Per-funder fee budget.
   *
   * If `feeBudget` is configured, the server tracks the stroops charged per
   * fee-payer key within a rolling window. The conservative per-settlement
   * charge is `maxFeeBumpStroops` (the configured ceiling on network fees).
   *
   * The charge is recorded BEFORE broadcast (fail-safe: admitted-but-reverting
   * txs still cost fees, so we must not under-count). A read-only check runs
   * earlier, before the closing latch is written, so a close the budget would
   * refuse does not stop the channel.
   */
  type FeeBudgetRecord = { windowStartMs: number; spentStroops: number }

  /** Key of the fee-payer's budget record (the key that actually pays the fee). */
  function feeBudgetStoreKey(): string {
    const funderKey = feeBumpKP?.publicKey() ?? envelopeKP?.publicKey() ?? ''
    return `${STORE_PREFIX}:feebudget:${funderKey}`
  }

  /**
   * Pure transition: returns the budget record after charging one settlement,
   * or throws if the charge would exceed the budget.
   *
   * @throws {ChannelVerificationError} If the budget is exceeded.
   */
  function chargeFeeBudget(current: FeeBudgetRecord | null): FeeBudgetRecord {
    const budget = feeBudget!
    const charge = maxFeeBumpStroops
    const now = Date.now()
    const inWindow = current !== null && now - current.windowStartMs < budget.windowMs
    const windowStartMs = inWindow ? current.windowStartMs : now
    const spentStroops = inWindow ? current.spentStroops : 0

    if (spentStroops + charge > budget.maxStroops) {
      const funderKey = feeBumpKP?.publicKey() ?? envelopeKP?.publicKey()
      const details = {
        funderKey,
        spentStroops,
        charge,
        budgetStroops: budget.maxStroops,
        windowMs: budget.windowMs,
      }
      // The error message reaches the client, so the funder key and budget
      // configuration go only to the server log.
      logger.warn(
        `${LOG_PREFIX} Fee budget exceeded for funder ${funderKey}: spent ${spentStroops} stroops + charge ${charge} stroops exceeds budget ${budget.maxStroops} stroops within ${budget.windowMs} ms window.`,
        details,
      )
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Fee budget exceeded: this settlement would exceed the server's fee budget for the current window. Retry later.`,
        details,
      )
    }

    return { windowStartMs, spentStroops: spentStroops + charge }
  }

  /** Read-only budget check; writes nothing. */
  function assertFeeBudgetAvailable(current: unknown): void {
    if (!feeBudget) return
    chargeFeeBudget((current as FeeBudgetRecord | null) ?? null)
  }

  /**
   * Charges one settlement against the fee budget.
   *
   * @throws {ChannelVerificationError} If the budget is exceeded.
   */
  async function enforceFeeBudget(): Promise<void> {
    if (!feeBudget) {
      // No budget configured — backward compatible behavior.
      return
    }

    // Settlement only runs when an envelope signer is configured, so the
    // fee-payer key is always defined here; the early return is purely defensive.
    if (!feeBumpKP && !envelopeKP) {
      return
    }

    // Atomic read-modify-write so the budget holds under concurrent settlements
    // (which run outside the cumulative lock).
    await store.update(feeBudgetStoreKey(), (current): Store.Change<FeeBudgetRecord, void> => ({
      op: 'set',
      value: chargeFeeBudget(current as FeeBudgetRecord | null),
      result: undefined,
    }))
  }

  /**
   * Broadcasts a transaction via Soroban RPC, polls for confirmation, and
   * returns the transaction hash on success.
   *
   * @param tx - The signed transaction (or FeeBumpTransaction) to submit.
   * @param label - Action label for error messages (e.g. "Close").
   * @throws {SettlementError} If the broadcast throws or returns a non-PENDING
   *   status, or if polling does not confirm the transaction.
   */
  async function broadcastAndPoll(
    tx: Transaction | FeeBumpTransaction,
    label: string,
  ): Promise<string> {
    logger.debug(`${LOG_PREFIX} Broadcasting ${label.toLowerCase()} tx...`)
    let sendResult: rpc.Api.SendTransactionResponse
    try {
      sendResult = await rpcServer.sendTransaction(tx)
    } catch (error) {
      throw new SettlementError(
        `${LOG_PREFIX} ${label} broadcast failed: could not broadcast transaction.`,
        { details: error instanceof Error ? error.message : String(error) },
      )
    }

    if (sendResult.status !== 'PENDING') {
      throw new SettlementError(
        `${LOG_PREFIX} ${label} broadcast failed: sendTransaction returned ${sendResult.status}.`,
        { hash: sendResult.hash, status: sendResult.status },
      )
    }

    // pollTransaction only returns on SUCCESS; FAILED, timeouts, and semaphore
    // exhaustion all throw. Whatever happened, the channel stays closing and
    // closeWithLatestCommitment completes the close from the chain state.
    try {
      await pollTransaction(rpcServer, sendResult.hash, {
        maxAttempts: pollMaxAttempts,
        delayMs: pollDelayMs,
        timeoutMs: pollTimeoutMs,
        semaphore: pollSemaphore,
      })
    } catch (error) {
      if (error instanceof TransactionFailedError) {
        throw new SettlementError(`${LOG_PREFIX} ${label} transaction failed on-chain.`, {
          hash: sendResult.hash,
          details: error.message,
        })
      }
      throw new SettlementError(
        `${LOG_PREFIX} ${label} settlement did not confirm — the channel stays closing; closeWithLatestCommitment completes the close.`,
        {
          hash: sendResult.hash,
          details: error instanceof Error ? error.message : String(error),
        },
      )
    }

    return sendResult.hash
  }

  /**
   * Lazily checks on-chain channel state to detect disputes and enforce
   * deposit limits. Called once per voucher/close verify when
   * `checkOnChainState` is enabled.
   *
   * @param commitmentAmount - The cumulative commitment to validate against the on-chain deposit.
   * @throws {ChannelVerificationError} If a close has started on-chain, the
   *   commitment exceeds the deposit, or the RPC call fails.
   */
  async function verifyOnChainState(commitmentAmount: bigint): Promise<void> {
    let state: ChannelState
    try {
      state = await getChannelState({
        channel: channelAddress,
        network,
        rpcUrl,
        simulationTimeoutMs,
      })
    } catch (error) {
      // Fail closed — reject the voucher when the on-chain
      // check cannot be completed rather than silently skipping it.
      throw new ChannelVerificationError(
        `${LOG_PREFIX} On-chain state check failed. Cannot verify channel status.`,
        { error: error instanceof Error ? error.message : String(error) },
      )
    }

    // The channel contract is deployed out-of-band; when the operator pins an
    // expected payout address, reject a contract that would settle to anyone
    // else, so vouchers are never credited against a channel paying a third party.
    if (recipient !== undefined && state.to !== recipient) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel payout address does not match the configured recipient.`,
        { expected: recipient, actual: state.to },
      )
    }

    // Likewise, reject a channel that would pay out a different token than the
    // operator expects, so vouchers priced in the intended currency are never
    // credited against a channel settling in an attacker-controlled token.
    if (currency !== undefined && state.token !== currency) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel token does not match the configured currency.`,
        { expected: currency, actual: state.token },
      )
    }

    logger.debug(`${LOG_PREFIX} On-chain state check`, {
      balance: state.balance.toString(),
      withdrawn: state.withdrawn.toString(),
      closeAt: state.closeEffectiveAtLedger,
    })

    await store.put(`${STORE_PREFIX}:state:${channelAddress}`, {
      balance: state.balance.toString(),
      withdrawn: state.withdrawn.toString(),
      closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      currentLedger: state.currentLedger,
      queriedAt: new Date().toISOString(),
    })

    // A close that has started on-chain cannot be cancelled, so the channel is
    // ending: reject the credential and let the operator's dispute handler
    // close with the stored commitment before the waiting period ends.
    if (state.closeEffectiveAtLedger != null) {
      onDisputeDetected?.(state)

      logger.warn(`${LOG_PREFIX} Channel is closing on-chain — rejecting credential`, {
        closeEffectiveAtLedger: state.closeEffectiveAtLedger,
        closeStatusLedger: state.closeStatusLedger,
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel is closing on-chain: a close has started.`,
        {
          closeEffectiveAtLedger: String(state.closeEffectiveAtLedger),
          closeStatusLedger: String(state.closeStatusLedger),
        },
      )
    }

    // The commitment is cumulative, so compare it with everything ever
    // deposited (balance plus amounts already withdrawn), not the balance alone.
    if (commitmentAmount > state.deposited) {
      logger.warn(`${LOG_PREFIX} Commitment exceeds channel deposit`, {
        commitmentAmount: commitmentAmount.toString(),
        deposited: state.deposited.toString(),
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Commitment ${commitmentAmount} exceeds channel deposit ${state.deposited}.`,
        {
          commitmentAmount: commitmentAmount.toString(),
          deposited: state.deposited.toString(),
        },
      )
    }
  }
}

/**
 * Inspect a `prepareTransaction`-built close transaction before it is signed.
 *
 * `prepareTransaction` runs the channel contract in recording-mode simulation and
 * inlines whatever authorization the contract requested. Because the channel
 * contract is deployed out-of-band, a malicious one could request authorization
 * for an injected sub-invocation (e.g. a token transfer out of the signer's own
 * account) that the envelope signature would then implicitly authorize. Confirm
 * the transaction is exactly a `close` call on the expected channel and that no
 * authorization entry carries sub-invocations before signing it.
 */
function assertPreparedCloseIsSafe(preparedTx: Transaction, channelAddress: string): void {
  const { contractAddress, invokeArgs, authEntries } = verifyInvokeContractOp(
    preparedTx,
    LOG_PREFIX,
  )
  if (contractAddress !== channelAddress) {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Prepared close targets an unexpected contract.`,
      { expected: channelAddress, actual: contractAddress },
    )
  }
  const functionName = invokeArgs.functionName().toString()
  if (functionName !== 'close') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Prepared close invokes an unexpected function.`,
      { functionName },
    )
  }
  for (const entry of authEntries) {
    if (entry.rootInvocation().subInvocations().length > 0) {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Prepared close authorization carries unexpected sub-invocations.`,
        {},
      )
    }
  }
}

/**
 * Returns the latest verified commitment amount and signature from the channel
 * server's store, or null when no signature is stored (including records written
 * by earlier versions).
 *
 * This is a read only. Use {@link closeWithLatestCommitment} to stop voucher
 * acceptance and close with the stored commitment.
 *
 * @throws {ChannelVerificationError} If the stored record is malformed.
 */
export async function getLatestCommitment(parameters: {
  /** Store passed to the channel server method. */
  store: Store.Store
  /** On-chain channel contract address (C...). */
  channel: string
}): Promise<{ amount: bigint; signature: Uint8Array } | null> {
  const { store, channel: channelAddress } = parameters
  const record = (await store.get(cumulativeStoreKey(channelAddress))) as CumulativeRecord | null
  if (!record || record.signature === undefined) return null

  return parseStoredCommitment(record, channelAddress)
}

function parseStoredCommitment(record: CumulativeRecord, channelAddress: string) {
  try {
    if (typeof record.signature !== 'string') throw new Error('Invalid signature')
    validateHexSignature(record.signature)
    if (typeof record.amount !== 'string') throw new Error('Invalid amount')
    validateAmount(record.amount)
    return {
      amount: BigInt(record.amount),
      signature: Buffer.from(record.signature, 'hex'),
    }
  } catch {
    throw new ChannelVerificationError(`${LOG_PREFIX} Stored commitment record is malformed.`, {
      channel: channelAddress,
    })
  }
}

/**
 * Close the channel with the latest verified commitment in the server's store.
 *
 * Stops voucher acceptance and reads the commitment in one atomic store update,
 * so every voucher is either covered by the close or rejected. The latch is
 * permanent: closing is final, and the channel never accepts credentials again.
 *
 * Completion is judged from the chain, not from a transaction's outcome. The
 * helper first reads the channel state and returns `null` without sending
 * anything when `withdrawn` already covers the stored amount. Otherwise it
 * sends `close(amount, signature)` and polls for confirmation. The contract
 * pays only the amount not yet withdrawn, so the helper is safe to call again
 * after any failure or unknown outcome: a rejected send, an on-chain failure,
 * a poll timeout or a lost response all mean "call again later". Sends are
 * counted per channel in the store and capped at `maxCloseSends` to bound fee
 * spend on a close that keeps failing; past the cap, the call throws without
 * sending and the operator reconciles.
 *
 * Call this before the refund waiting period ends, when `watchChannel` reports a
 * `close` event with a future `effectiveAtLedger`. `watchChannel` starts at the
 * latest ledger, so on startup read the latest ledger, then call
 * `getChannelState`, call this when `closeEffectiveAtLedger` is set and later
 * than `closeStatusLedger`, and watch from the ledger read first (`startLedger`).
 * It is also safe to start inside `onDisputeDetected`; the callback does not
 * await it, so attach a `.catch(...)` rejection handler.
 *
 * The store must provide atomic `update()` semantics across all server
 * instances. Like {@link close}, this helper does not apply the channel
 * server's `feeBudget`. RPC and store errors propagate unchanged.
 *
 * @returns The close transaction hash, or `null` when a confirmed close is
 *   already recorded or the chain already showed the stored amount withdrawn,
 *   so nothing was sent.
 * @throws {ChannelVerificationError} If the stored commitment is missing or
 *   malformed, the store has no atomic
 *   `update()`, the send cap is reached, or the broadcast returns a
 *   non-`PENDING` status.
 * @throws {TransactionFailedError} If the close transaction fails on-chain.
 * @throws {PollTimeoutError} If polling exceeds the configured timeout.
 * @throws {PollMaxAttemptsError} If polling exhausts the configured attempts.
 */
export async function closeWithLatestCommitment(
  parameters: Omit<close.Parameters, 'amount' | 'signature'> & {
    /** Atomic store passed to the channel server method. */
    store: Store.AtomicStore
    /**
     * Maximum close transactions sent for this channel across all calls and
     * instances. @default 10
     */
    maxCloseSends?: number
  },
): Promise<string | null> {
  const { store, maxCloseSends = DEFAULT_MAX_CLOSE_SENDS, ...rest } = parameters
  const { channel: channelAddress, network = STELLAR_TESTNET, rpcUrl, logger = noopLogger } = rest
  const cumulativeKey = cumulativeStoreKey(channelAddress)
  const closedKey = closedStoreKey(channelAddress)

  // A confirmed close is cached; nothing is left to send.
  if (await store.get(closedKey)) {
    logger.info(`${LOG_PREFIX} Channel close already confirmed; nothing to send.`, {
      channel: channelAddress,
    })
    return null
  }
  if (typeof store.update !== 'function') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} An atomic store providing compare-and-set semantics via update() is required for closing with the stored commitment.`,
      { channel: channelAddress },
    )
  }

  // Latch and select in one atomic update. A record that is already closing
  // keeps its pair: the close is simply sent (again) for it.
  type Selection =
    | { success: true; amount: bigint; signature: Uint8Array }
    | { success: false; error: ChannelVerificationError }
  const selection = await store.update(
    cumulativeKey,
    (current): Store.Change<CumulativeRecord, Selection> => {
      const record = current as CumulativeRecord | null
      if (!record || record.signature === undefined) {
        return {
          op: 'noop',
          result: {
            success: false,
            error: new ChannelVerificationError(
              `${LOG_PREFIX} No stored commitment to close with`,
              { channel: channelAddress },
            ),
          },
        }
      }
      let pair: { amount: bigint; signature: Uint8Array }
      try {
        pair = parseStoredCommitment(record, channelAddress)
      } catch (error) {
        return { op: 'noop', result: { success: false, error: error as ChannelVerificationError } }
      }
      if (isClosing(record)) {
        return { op: 'noop', result: { success: true, ...pair } }
      }
      return {
        op: 'set',
        value: { amount: record.amount, signature: record.signature, closing: true },
        result: { success: true, ...pair },
      }
    },
  )
  if (!selection.success) throw selection.error
  const { amount, signature } = selection

  // The chain decides whether the close is already done. A close that landed
  // after an unknown outcome shows up here, and nothing is sent.
  const state = await getChannelState({
    channel: channelAddress,
    network,
    rpcUrl,
    simulationTimeoutMs: rest.simulationTimeoutMs,
  })
  if (state.withdrawn >= amount) {
    logger.info(`${LOG_PREFIX} Stored commitment already withdrawn on-chain; nothing to send.`, {
      channel: channelAddress,
      amount: amount.toString(),
      withdrawn: state.withdrawn.toString(),
    })
    await store.put(closedKey, { closedAt: new Date().toISOString(), amount: amount.toString() })
    return null
  }

  // Build and sign before counting, so a close that never reaches the network
  // (RPC down, simulation failure) does not use up the send cap.
  const prepared = await buildClose({ ...rest, amount, signature })

  // Bound the fees a close that keeps failing can cost: count sends across
  // calls and instances, and stop past the cap.
  const sends = await store.update(
    closeSendsStoreKey(channelAddress),
    (current): Store.Change<{ count: number }, number> => {
      const count = ((current as { count?: number } | null)?.count ?? 0) + 1
      if (count > maxCloseSends) return { op: 'noop', result: count }
      return { op: 'set', value: { count }, result: count }
    },
  )
  if (sends > maxCloseSends) {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Close send limit reached: ${maxCloseSends} close transactions were already sent for this channel. Reconcile against the chain before sending more.`,
      { channel: channelAddress, maxCloseSends: String(maxCloseSends) },
    )
  }

  const txHash = await sendClose(prepared, rest)
  await store.put(closedKey, {
    closedAt: new Date().toISOString(),
    txHash,
    amount: amount.toString(),
  })
  return txHash
}

/**
 * Close the channel contract on-chain using a signed commitment.
 * Transfers the committed amount to the recipient and auto-refunds
 * the remaining balance to the funder. This is a server-side
 * administrative operation.
 *
 * The contract pays only the amount not yet withdrawn, so repeating a close
 * with the same or a higher commitment is safe.
 *
 * Note: this standalone helper is not routed through `verify()`, so any
 * `feeBudget` configured on the channel server does not apply here, and it
 * does not stop the channel server from accepting vouchers. Use
 * {@link closeWithLatestCommitment} while the server is running.
 */
export async function close(parameters: close.Parameters): Promise<string> {
  return sendClose(await buildClose(parameters), parameters)
}

type PreparedClose = { server: rpc.Server; tx: Transaction | FeeBumpTransaction }

/** Builds, simulates, checks and signs a `close(amount, signature)` transaction. */
async function buildClose(parameters: close.Parameters): Promise<PreparedClose> {
  const {
    channel: channelAddress,
    amount,
    signature,
    feePayer,
    network = STELLAR_TESTNET,
    rpcUrl,
    maxFeeBumpStroops = DEFAULT_MAX_FEE_BUMP_STROOPS,
  } = parameters

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const networkPassphrase = NETWORK_PASSPHRASE[network]
  const server = new rpc.Server(resolvedRpcUrl)

  const contract = new Contract(channelAddress)
  const closeOp = contract.call(
    'close',
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(Buffer.from(signature), { type: 'bytes' }),
  )

  const signer = resolveKeypair(feePayer.envelopeSigner)
  const account = await server.getAccount(signer.publicKey())
  const tx = new TransactionBuilder(account, {
    fee: DEFAULT_FEE,
    networkPassphrase,
  })
    .addOperation(closeOp)
    .setTimeout(DEFAULT_TIMEOUT)
    .build()

  const prepared = await server.prepareTransaction(tx)
  assertPreparedCloseIsSafe(prepared, channelAddress)
  prepared.sign(signer)

  let txToSubmit: Transaction | FeeBumpTransaction = prepared
  if (feePayer.feeBumpSigner) {
    txToSubmit = wrapFeeBump(prepared, resolveKeypair(feePayer.feeBumpSigner), {
      networkPassphrase,
      maxFeeStroops: maxFeeBumpStroops,
    })
  }
  return { server, tx: txToSubmit }
}

/** Sends a built close and polls until it confirms; returns its hash. */
async function sendClose(
  prepared: PreparedClose,
  parameters: Pick<
    close.Parameters,
    'pollMaxAttempts' | 'pollDelayMs' | 'pollTimeoutMs' | 'logger'
  >,
): Promise<string> {
  const {
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    logger: log = noopLogger,
  } = parameters
  const { server, tx } = prepared

  log.debug(`${LOG_PREFIX} Broadcasting close tx...`)
  const result = await server.sendTransaction(tx)

  if (result.status !== 'PENDING') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Close broadcast failed: sendTransaction returned ${result.status}.`,
      { hash: result.hash, status: result.status },
    )
  }

  await pollTransaction(server, result.hash, {
    maxAttempts: pollMaxAttempts,
    delayMs: pollDelayMs,
    timeoutMs: pollTimeoutMs,
  })

  return result.hash
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export declare namespace close {
  type Parameters = {
    /** Channel contract address. */
    channel: string
    /** Commitment amount to close with. */
    amount: bigint
    /** Ed25519 signature for the commitment. */
    signature: Uint8Array
    /**
     * Fee payer configuration for the close transaction.
     * `envelopeSigner` provides the source account and signs the envelope.
     * `feeBumpSigner` optionally wraps the tx in a FeeBumpTransaction.
     */
    feePayer: {
      envelopeSigner: Keypair | string
      feeBumpSigner?: Keypair | string
    }
    /** Network identifier. */
    network?: NetworkId
    /**
     * Soroban RPC endpoint URL.
     *
     * @defaultValue `"https://soroban-testnet.stellar.org"` (testnet) or
     *   `"https://soroban-rpc.mainnet.stellar.gateway.fm"` (pubnet)
     */
    rpcUrl?: string
    /** Maximum fee bump in stroops. */
    maxFeeBumpStroops?: number
    /** Maximum poll attempts. */
    pollMaxAttempts?: number
    /** Poll delay in ms. */
    pollDelayMs?: number
    /** Poll timeout in ms. */
    pollTimeoutMs?: number
    /** Per-RPC timeout for the on-chain state read in milliseconds. @default 10000 */
    simulationTimeoutMs?: number
    /** Logger instance. */
    logger?: Logger
  }
}

export declare namespace channel {
  type Parameters = {
    /** On-chain channel contract address (C...). */
    channel: string
    /**
     * When true, each verify call lazily reads on-chain state to detect
     * if `close_start` has been called (dispute detection). @default true
     */
    checkOnChainState?: boolean
    /**
     * Fee payer configuration for on-chain channel operations (close).
     *
     * `envelopeSigner` provides the source account and signs the envelope.
     * `feeBumpSigner` optionally wraps the transaction in a FeeBumpTransaction.
     *
     * Required when handling close credential actions.
     */
    feePayer?: {
      envelopeSigner: Keypair | string
      feeBumpSigner?: Keypair | string
    }
    /**
     * Ed25519 public key for verifying commitment signatures.
     * Accepts a Stellar public key string (G...) or a Keypair instance.
     */
    commitmentKey: string | Keypair
    /** Number of decimal places for amount conversion. @default 7 */
    decimals?: number
    /** Maximum fee bump in stroops. @default 10_000_000 */
    maxFeeBumpStroops?: number
    /** Stellar network. @default 'stellar:testnet' */
    network?: NetworkId
    /**
     * Called when a close has started on-chain (`close_start`, or a close that
     * already took effect). The credential being verified is rejected right
     * after this callback, since the channel is ending. Use it to call
     * `closeWithLatestCommitment`, which closes with the stored commitment
     * before the waiting period elapses and is safe to call repeatedly. This
     * runs only while credentials are verified, so also call it from
     * `watchChannel` `close` events and a startup `getChannelState` check.
     * The callback does not await the close; attach a `.catch(...)` rejection handler.
     */
    onDisputeDetected?: (state: ChannelState) => void
    /**
     * Expected on-chain payout address (G...) for the channel.
     *
     * The channel contract is deployed out-of-band, so its payout address is not
     * inherently trusted. When set, each on-chain state check rejects a channel
     * whose `to` differs from this value, so vouchers are never credited against a
     * channel that would settle to a third party. Strongly recommended; when
     * omitted the payout address is not verified and a startup warning is logged.
     */
    recipient?: string
    /**
     * Expected on-chain token contract address (C...) for the channel.
     *
     * The channel contract is deployed out-of-band, so the token it pays out in
     * is not inherently trusted. When set, each on-chain state check rejects a
     * channel whose token differs from this value, so vouchers priced in the
     * intended currency are never credited against a channel settling in a
     * different (potentially worthless) token. Strongly recommended; when omitted
     * the token is not verified and a startup warning is logged.
     */
    currency?: string
    /** Maximum poll attempts when waiting for transaction confirmation. @default 20 */
    pollMaxAttempts?: number
    /** Maximum concurrent polling operations for this server instance. @default 10 */
    pollMaxConcurrent?: number
    /** Poll delay between attempts in milliseconds. @default 1000 */
    pollDelayMs?: number
    /** Poll timeout in milliseconds. @default 20_000 */
    pollTimeoutMs?: number
    /**
     * Custom Soroban RPC URL.
     * @defaultValue
     * ```ts
     * {
     *   [STELLAR_PUBNET]: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
     *   [STELLAR_TESTNET]: 'https://soroban-testnet.stellar.org',
     * }
     * ```
     */
    rpcUrl?: string
    /**
     * Maximum credential verifications allowed to hold an on-chain state read
     * at once (`checkOnChainState`). The reads run outside the cumulative lock
     * so a slow RPC cannot stall concurrent payers, which makes this the only
     * bound on RPC fan-out under a burst of credentials. Callers past the limit
     * queue briefly and are then rejected with a `SemaphoreTimeoutError`.
     *
     * Commitment signatures are verified against a locally-built message, so
     * they never touch RPC and are not covered by this limit.
     *
     * @default 10
     */
    verifyMaxConcurrent?: number
    /** Simulation timeout in milliseconds. @default 10_000 */
    simulationTimeoutMs?: number
    /**
     * Persistent atomic store for replay protection, cumulative amount tracking,
     * and channel lifecycle state (closing/closed).
     *
     * Required — channel state coordination depends on this store. Without it,
     * duplicate processing, non-monotonic commitments, and post-close voucher
     * acceptance are all possible.
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
     * - Multi-process (e.g. multiple pods behind a load balancer): a backend whose
     *   `update()` maps to a genuine atomic CAS, such as a Redis Lua script or a
     *   PostgreSQL conditional `UPDATE … WHERE`. A plain get-then-put against a
     *   shared cache is not sufficient.
     */
    store: Store.AtomicStore
    /**
     * Optional fee budget to limit server spending on per-funder settlement transactions.
     * When set, the server tracks the total fees paid per fee-payer key within a rolling
     * time window. Each close settlement is conservatively charged the
     * `maxFeeBumpStroops` amount against the budget.
     *
     * When unset (default), there is no budget enforcement and behavior is unchanged
     * (backward compatible).
     *
     * The fee payer (funder key) is determined as:
     * - `feeBumpSigner.publicKey()` if `feeBumpSigner` is set
     * - Otherwise, `envelopeSigner.publicKey()`
     *
     * A read-only budget check runs before a close credential latches the
     * channel, and the charge is taken before broadcast in `doVerifyClose`.
     * A settlement rejected for budget exhaustion throws `ChannelVerificationError` with
     * clear context (funder key, spent, cap, window).
     *
     * The fee budget is NOT applied to the standalone exported `close()` and
     * `closeWithLatestCommitment()` functions (operator-initiated actions);
     * the latter bounds its sends with `maxCloseSends` instead.
     */
    feeBudget?: {
      /** Maximum total stroops the server will spend per funder key within the window. */
      maxStroops: number
      /** Rolling time window in milliseconds. */
      windowMs: number
    }
    /** Logger for debug/warn messages. @default noopLogger */
    logger?: Logger
  }
}
