import {
  Account,
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
  ALL_ZEROS,
  DEFAULT_DECIMALS,
  DEFAULT_FEE,
  DEFAULT_TIMEOUT,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
  type NetworkId,
} from '../../constants.js'
import {
  DEFAULT_MAX_FEE_BUMP_STROOPS,
  DEFAULT_POLL_DELAY_MS,
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_MAX_CONCURRENT,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SIMULATION_TIMEOUT_MS,
} from '../../shared/defaults.js'
import { Semaphore } from '../../shared/semaphore.js'
import { ChannelVerificationError } from '../../shared/errors.js'
import { wrapFeeBump } from '../../shared/fee-bump.js'
import { resolveKeypair } from '../../shared/keypairs.js'
import { noopLogger, type Logger } from '../../shared/logger.js'
import { pollTransaction } from '../../shared/poll.js'
import { toBaseUnits } from '../../shared/units.js'
import { simulateCall } from '../../shared/simulate.js'
import { validateAmount, validateHexSignature } from '../../shared/validation.js'
import { channel as ChannelMethod } from '../Methods.js'
import { getChannelState, type ChannelState } from './State.js'

type ChannelCredential = Parameters<Method.VerifyFn<typeof ChannelMethod>>[0]['credential']
type CumulativeRecord = {
  amount: string
  settling?: boolean
  settlingAmount?: string
  settledAt?: string
}

/**
 * Creates a Stellar one-way-channel method for use on the **server**.
 *
 * The server:
 * 1. Issues challenges with the channel contract address and cumulative amount
 * 2. Verifies commitment signatures against the channel's commitment key
 * 3. Optionally closes the channel and settles funds on-chain
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
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollMaxConcurrent = DEFAULT_POLL_MAX_CONCURRENT,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    rpcUrl,
    simulationTimeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS,
    store,
    feeBudget,
    logger = noopLogger,
  } = parameters

  const resolvedRpcUrl = rpcUrl ?? SOROBAN_RPC_URLS[network]
  const networkPassphrase = NETWORK_PASSPHRASE[network]
  const rpcServer = new rpc.Server(resolvedRpcUrl)
  const pollSemaphore = new Semaphore(pollMaxConcurrent)

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
  const cumulativeKey = `${STORE_PREFIX}:cumulative:${channelAddress}`

  // Track channel settlement in-progress state. Set under the lock when a close
  // is accepted, cleared after successful settlement. If settlement fails, the
  // marker remains to fail-closed: prevent acceptance of new credentials pending
  // operator reconciliation.
  const settlingKey = `${STORE_PREFIX}:settling:${channelAddress}`

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
      // Phase 1: validate and update cumulative under lock (fast path).
      // Phase 2: long operations (broadcast, poll) run outside the lock.
      const validated = await new Promise<ValidatedCredential>((resolve, reject) => {
        cumulativeLock = cumulativeLock.then(
          () => doValidate(credential).then(resolve, reject),
          () => doValidate(credential).then(resolve, reject),
        )
      })
      return doSettle(validated)
    },
  })

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
   * Phase 1 — validation (runs under {@link cumulativeLock}).
   *
   * Performs replay protection, cumulative amount checks, and signature
   * verification. For vouchers, writes the cumulative and returns the
   * receipt directly. For close, returns the validated state so
   * the long on-chain operation can run outside the lock.
   */
  async function doValidate(credential: ChannelCredential): Promise<ValidatedCredential> {
    const { challenge, payload } = credential
    const { request: challengeRequest } = challenge

    const action = payload.action ?? 'voucher'
    const { externalId } = challengeRequest

    // Reject credentials once the channel has been closed on-chain. Applied to all actions.
    const closed = await store.get(`${STORE_PREFIX}:closed:${channelAddress}`)
    if (closed) {
      logger.warn(`${LOG_PREFIX} Rejecting credential — channel already closed`, {
        channel: channelAddress,
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel has been closed. No further credentials accepted.`,
        { channel: channelAddress },
      )
    }

    // Reject all actions if a close is currently settling. The settling marker is set
    // atomically under the lock when a close is accepted, and remains set until settlement
    // completes or fails. During settlement, the channel must not accept new credentials.
    // If settlement fails, the marker stays set to fail-closed: no silent reopening.
    const settling = await store.get(settlingKey)
    if (settling) {
      logger.warn(`${LOG_PREFIX} Rejecting credential — channel is settling`, {
        channel: channelAddress,
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel is settling — no further credentials accepted until settlement completes.`,
        { channel: channelAddress },
      )
    }
    const cumulativeRecord = await store.get(cumulativeKey)
    if (
      cumulativeRecord &&
      typeof cumulativeRecord === 'object' &&
      'settling' in cumulativeRecord &&
      (cumulativeRecord as CumulativeRecord).settling
    ) {
      logger.warn(`${LOG_PREFIX} Rejecting credential — channel is settling`, {
        channel: channelAddress,
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Channel is settling — no further credentials accepted until settlement completes.`,
        { channel: channelAddress },
      )
    }

    // Replay protection via atomic compare-and-set: reject if challenge already used.
    // Applied to all actions.
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

    if (checkOnChainState) {
      await verifyOnChainState(commitmentAmount)
    }

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

    // Verify commitment signature before atomic cumulative update
    // (async work must complete before the atomic CAS)
    await verifyCommitmentSignature(commitmentAmount, signatureBytes)

    // Atomic cumulative monotonic check and write: reject if invariants fail,
    // or write the new cumulative if all checks pass.
    type CumulativeResult = { success: true } | { success: false; error: ChannelVerificationError }

    const cumulativeUpdateResult = await store.update(
      cumulativeKey,
      (current): Store.Change<CumulativeRecord, CumulativeResult> => {
        let previousCumulative = 0n
        if (current && typeof current === 'object' && 'amount' in current) {
          const record = current as CumulativeRecord
          if (record.settling) {
            return {
              op: 'noop',
              result: {
                success: false,
                error: new ChannelVerificationError(
                  `${LOG_PREFIX} Channel is settling — no further credentials accepted until settlement completes.`,
                  { channel: channelAddress },
                ),
              },
            }
          }
          previousCumulative = BigInt(record.amount)
        }

        // The new cumulative must be strictly greater than previous cumulative
        if (commitmentAmount <= previousCumulative) {
          return {
            op: 'noop',
            result: {
              success: false,
              error: new ChannelVerificationError(
                `${LOG_PREFIX} Commitment amount ${commitmentAmount} must be greater than previous cumulative ${previousCumulative}.`,
                {
                  commitmentAmount: commitmentAmount.toString(),
                  previousCumulative: previousCumulative.toString(),
                },
              ),
            },
          }
        }

        // The commitment must cover the requested amount
        if (commitmentAmount < previousCumulative + requestedAmount) {
          return {
            op: 'noop',
            result: {
              success: false,
              error: new ChannelVerificationError(
                `${LOG_PREFIX} Commitment amount ${commitmentAmount} does not cover the requested amount ${requestedAmount} (previous cumulative: ${previousCumulative}).`,
                {
                  commitmentAmount: commitmentAmount.toString(),
                  requestedAmount: requestedAmount.toString(),
                  previousCumulative: previousCumulative.toString(),
                },
              ),
            },
          }
        }

        // All checks passed, write the new cumulative
        return {
          op: 'set',
          result: { success: true },
          value:
            action === 'close'
              ? {
                  amount: commitmentAmount.toString(),
                  settling: true,
                  settlingAmount: commitmentAmount.toString(),
                  settledAt: new Date().toISOString(),
                }
              : { amount: commitmentAmount.toString() },
        }
      },
    )

    if (!cumulativeUpdateResult.success) {
      throw cumulativeUpdateResult.error
    }

    // Close: set settling marker to block new credentials during phase 2 settlement.
    // Cumulative was already written atomically above. The settling marker remains set
    // until settlement completes (marker cleared) or fails (marker remains to fail-closed).
    if (action === 'close') {
      await store.put(settlingKey, {
        settlingAmount: commitmentAmount.toString(),
        settledAt: new Date().toISOString(),
      })
      return { action: 'close', commitmentAmount, signatureBytes, challengeStoreKey, externalId }
    }

    // Voucher path: cumulative was already written atomically above.
    // Mark the challenge as used and return receipt directly (no long operation).
    await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

    return {
      action: 'voucher',
      receipt: Receipt.from({
        method: 'stellar',
        reference: challengeRequest.methodDetails?.reference ?? challenge.id,
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
   * @throws {ChannelVerificationError} If no envelopeSigner is configured,
   *   broadcast returns a non-PENDING status, or the on-chain tx fails.
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
    await store.put(`${STORE_PREFIX}:closed:${channelAddress}`, {
      closedAt: new Date().toISOString(),
      txHash,
      amount: commitmentAmount.toString(),
    })

    // Clear settling marker — it is now redundant because the closed marker blocks everything.
    // This is done for cleanliness after a successful settlement.
    await store.delete(settlingKey)

    await store.put(challengeStoreKey, { state: 'used', usedAt: new Date().toISOString() })

    return Receipt.from({
      method: 'stellar',
      reference: txHash,
      status: 'success',
      timestamp: new Date().toISOString(),
      ...(externalId ? { externalId } : {}),
    })
  }

  /**
   * Simulates `prepare_commitment` on the channel contract and verifies
   * the ed25519 signature against the returned commitment bytes.
   *
   * @throws {ChannelVerificationError} If the simulation returns no value
   *   or the signature does not match.
   */
  async function verifyCommitmentSignature(
    commitmentAmount: bigint,
    signatureBytes: Buffer,
  ): Promise<void> {
    logger.debug(`${LOG_PREFIX} Verifying commitment signature...`)
    const contract = new Contract(channelAddress)
    const call = contract.call(
      'prepare_commitment',
      nativeToScVal(commitmentAmount, { type: 'i128' }),
    )

    const account = new Account(ALL_ZEROS, '0')
    const simTx = new TransactionBuilder(account, {
      fee: DEFAULT_FEE,
      networkPassphrase,
    })
      .addOperation(call)
      .setTimeout(simulationTimeoutMs / 1000)
      .build()

    const simResult = await simulateCall(rpcServer, simTx, { timeoutMs: simulationTimeoutMs })

    const returnValue = simResult.result?.retval
    if (!returnValue) {
      throw new ChannelVerificationError(`${LOG_PREFIX} prepare_commitment returned no value.`, {})
    }

    const commitmentBytes = returnValue.bytes()
    const valid = commitmentKP.verify(Buffer.from(commitmentBytes), signatureBytes)

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
   * Enforces per-funder fee budget before settlement broadcast.
   *
   * If `feeBudget` is configured, checks whether the funder key has exceeded
   * the maximum stroops within the rolling window. The conservative per-settlement
   * charge is `maxFeeBumpStroops` (the configured ceiling on network fees).
   *
   * Charge is recorded BEFORE broadcast (fail-safe: admitted-but-reverting txs
   * still cost fees, so we must not under-count).
   *
   * @throws {ChannelVerificationError} If the budget is exceeded.
   */
  type FeeBudgetRecord = { windowStartMs: number; spentStroops: number }

  async function enforceFeeBudget(): Promise<void> {
    if (!feeBudget) {
      // No budget configured — backward compatible behavior.
      return
    }

    // Funder key is the public key that actually pays the network fee.
    // Settlement only runs when an envelope signer is configured, so this is
    // always defined here; the early return is purely defensive.
    const funderKey = feeBumpKP?.publicKey() ?? envelopeKP?.publicKey()
    if (!funderKey) {
      return
    }

    const budgetKey = `${STORE_PREFIX}:feebudget:${funderKey}`
    // Conservative per-settlement charge: the configured ceiling on the network
    // fee the server may pay for one settlement.
    const charge = maxFeeBumpStroops

    // Pure transition: returns the updated record or throws if the charge would
    // exceed the budget. Recording the charge BEFORE broadcast is intentional —
    // an admitted-but-reverting tx still costs fees, so we must not under-count.
    const applyCharge = (current: FeeBudgetRecord | null): FeeBudgetRecord => {
      const now = Date.now()
      const inWindow = current !== null && now - current.windowStartMs < feeBudget.windowMs
      const windowStartMs = inWindow ? current.windowStartMs : now
      const spentStroops = inWindow ? current.spentStroops : 0

      if (spentStroops + charge > feeBudget.maxStroops) {
        throw new ChannelVerificationError(
          `${LOG_PREFIX} Fee budget exceeded for funder ${funderKey}: spent ${spentStroops} stroops + charge ${charge} stroops exceeds budget ${feeBudget.maxStroops} stroops within ${feeBudget.windowMs} ms window.`,
          {
            funderKey,
            spentStroops,
            charge,
            budgetStroops: feeBudget.maxStroops,
            windowMs: feeBudget.windowMs,
          },
        )
      }

      return { windowStartMs, spentStroops: spentStroops + charge }
    }

    // Prefer the store's atomic read-modify-write so the budget holds under
    // concurrent settlements (which run outside the cumulative lock). Stores
    // without `update` fall back to get/put — best-effort under cross-process
    // races, acceptable for a fee-drain guard rather than a hard cap.
    const atomicStore = store as {
      update?: (
        key: string,
        fn: (current: FeeBudgetRecord | null) => Store.Change<FeeBudgetRecord, void>,
      ) => Promise<void>
    }

    if (typeof atomicStore.update === 'function') {
      await atomicStore.update(budgetKey, (current) => ({
        op: 'set',
        value: applyCharge(current),
        result: undefined,
      }))
    } else {
      const current = (await store.get(budgetKey)) as FeeBudgetRecord | null
      await store.put(budgetKey, applyCharge(current))
    }
  }

  /**
   * Broadcasts a transaction via Soroban RPC, polls for confirmation, and
   * returns the transaction hash on success.
   *
   * @param tx - The signed transaction (or FeeBumpTransaction) to submit.
   * @param label - Action label for error messages (e.g. "Close").
   * @throws {ChannelVerificationError} If sendTransaction returns a non-PENDING
   *   status or the polled result is not SUCCESS.
   */
  async function broadcastAndPoll(
    tx: Transaction | FeeBumpTransaction,
    label: string,
  ): Promise<string> {
    logger.debug(`${LOG_PREFIX} Broadcasting ${label.toLowerCase()} tx...`)
    const sendResult = await rpcServer.sendTransaction(tx)

    if (sendResult.status !== 'PENDING') {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} ${label} broadcast failed: sendTransaction returned ${sendResult.status}.`,
        { hash: sendResult.hash, status: sendResult.status },
      )
    }

    const txResult = await pollTransaction(rpcServer, sendResult.hash, {
      maxAttempts: pollMaxAttempts,
      delayMs: pollDelayMs,
      timeoutMs: pollTimeoutMs,
      semaphore: pollSemaphore,
    })

    if (txResult.status !== 'SUCCESS') {
      throw new ChannelVerificationError(
        `${LOG_PREFIX} ${label} transaction failed: ${txResult.status}`,
        {
          hash: sendResult.hash,
          status: txResult.status,
        },
      )
    }

    return sendResult.hash
  }

  /**
   * Lazily checks on-chain channel state to detect disputes and enforce
   * balance limits. Called once per voucher/close verify when
   * `checkOnChainState` is enabled.
   *
   * @param commitmentAmount - The cumulative commitment to validate against the on-chain balance.
   * @throws {ChannelVerificationError} If the channel is closed on-chain, the
   *   commitment exceeds the balance, or the RPC call fails.
   */
  async function verifyOnChainState(commitmentAmount: bigint): Promise<void> {
    let state: ChannelState
    try {
      state = await getChannelState({
        channel: channelAddress,
        network,
        rpcUrl,
      })
    } catch (error) {
      // Fail closed — reject the voucher when the on-chain
      // check cannot be completed rather than silently skipping it.
      throw new ChannelVerificationError(
        `${LOG_PREFIX} On-chain state check failed. Cannot verify channel status.`,
        { error: error instanceof Error ? error.message : String(error) },
      )
    }

    logger.debug(`${LOG_PREFIX} On-chain state check`, {
      balance: state.balance.toString(),
      closeAt: state.closeEffectiveAtLedger,
    })

    await store.put(`${STORE_PREFIX}:state:${channelAddress}`, {
      balance: state.balance.toString(),
      closeEffectiveAtLedger: state.closeEffectiveAtLedger,
      currentLedger: state.currentLedger,
      queriedAt: new Date().toISOString(),
    })

    if (state.closeEffectiveAtLedger != null) {
      onDisputeDetected?.(state)

      if (state.currentLedger >= state.closeEffectiveAtLedger) {
        logger.warn(`${LOG_PREFIX} Channel is closed — effective ledger reached`, {
          closeEffectiveAtLedger: state.closeEffectiveAtLedger,
          currentLedger: state.currentLedger,
        })
        throw new ChannelVerificationError(
          `${LOG_PREFIX} Channel is closed: close effective ledger has been reached.`,
          {
            closeEffectiveAtLedger: String(state.closeEffectiveAtLedger),
            currentLedger: String(state.currentLedger),
          },
        )
      }
    }

    if (commitmentAmount > state.balance) {
      logger.warn(`${LOG_PREFIX} Commitment exceeds channel balance`, {
        commitmentAmount: commitmentAmount.toString(),
        balance: state.balance.toString(),
      })
      throw new ChannelVerificationError(
        `${LOG_PREFIX} Commitment ${commitmentAmount} exceeds channel balance ${state.balance}.`,
        {
          commitmentAmount: commitmentAmount.toString(),
          balance: state.balance.toString(),
        },
      )
    }
  }
}

/**
 * Close the channel contract on-chain using a signed commitment.
 * Transfers the committed amount to the recipient and auto-refunds
 * the remaining balance to the funder. This is a server-side
 * administrative operation.
 *
 * Note: this standalone helper is not routed through `verify()`, so any
 * `feeBudget` configured on the channel server does not apply here.
 */
export async function close(parameters: {
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
  /** Logger instance. */
  logger?: Logger
}): Promise<string> {
  const {
    channel: channelAddress,
    amount,
    signature,
    feePayer,
    network = STELLAR_TESTNET,
    rpcUrl,
    maxFeeBumpStroops = DEFAULT_MAX_FEE_BUMP_STROOPS,
    pollMaxAttempts = DEFAULT_POLL_MAX_ATTEMPTS,
    pollDelayMs = DEFAULT_POLL_DELAY_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    logger: log = noopLogger,
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
  prepared.sign(signer)

  let txToSubmit: Transaction | FeeBumpTransaction = prepared
  if (feePayer.feeBumpSigner) {
    txToSubmit = wrapFeeBump(prepared, resolveKeypair(feePayer.feeBumpSigner), {
      networkPassphrase,
      maxFeeStroops: maxFeeBumpStroops,
    })
  }

  log.debug(`${LOG_PREFIX} Broadcasting close tx...`)
  const result = await server.sendTransaction(txToSubmit)

  if (result.status !== 'PENDING') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Close broadcast failed: sendTransaction returned ${result.status}.`,
      { hash: result.hash, status: result.status },
    )
  }

  const txResult = await pollTransaction(server, result.hash, {
    maxAttempts: pollMaxAttempts,
    delayMs: pollDelayMs,
    timeoutMs: pollTimeoutMs,
  })

  if (txResult.status !== 'SUCCESS') {
    throw new ChannelVerificationError(
      `${LOG_PREFIX} Close transaction failed: ${txResult.status}`,
      {
        hash: result.hash,
        status: txResult.status,
      },
    )
  }

  return result.hash
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
     * Called when a dispute is detected on-chain (close_start has been called).
     * Use this to trigger a close response before the waiting period elapses.
     */
    onDisputeDetected?: (state: ChannelState) => void
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
    /** Simulation timeout in milliseconds. @default 10_000 */
    simulationTimeoutMs?: number
    /**
     * Persistent atomic store for replay protection, cumulative amount tracking,
     * and channel lifecycle state (settling/closed).
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
     * Budget enforcement runs BEFORE broadcast in `doVerifyClose`.
     * A settlement rejected for budget exhaustion throws `ChannelVerificationError` with
     * clear context (funder key, spent, cap, window).
     *
     * The fee budget is NOT applied to the standalone exported `close()` function
     * (operator-initiated admin actions).
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
