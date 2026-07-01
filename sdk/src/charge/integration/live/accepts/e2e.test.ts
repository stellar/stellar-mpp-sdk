import {
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import { Server as SorobanServer, Api } from '@stellar/stellar-sdk/rpc'
import { Credential, Method, Receipt, Store } from 'mppx'
import { Mppx as MppxServer } from 'mppx/server'
import { Mppx as MppxClient } from 'mppx/client'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEOUT,
  NETWORK_PASSPHRASE,
  STELLAR_TESTNET,
  XLM_SAC_TESTNET,
  SOROBAN_RPC_URLS,
} from '../../../../constants.js'
import { wrapFeeBump } from '../../../../shared/fee-bump.js'
import { pollTransaction } from '../../../../shared/poll.js'
import { resolveNetworkId } from '../../../../shared/validation.js'
import { charge as chargeMethod } from '../../../Methods.js'
import { charge as serverCharge } from '../../../server/Charge.js'
import { charge as clientCharge } from '../../../client/Charge.js'

// Every flow gets its own payer so a mid-broadcast failure in one flow cannot
// poison a later flow through a shared on-chain sequence. Sponsored flows also
// get their own envelope signer — the transaction source after the server
// rebuild, whose sequence likewise advances on settlement. The recipient only
// receives funds and the fee payer only sponsors fees (fee-bump outers carry no
// sequence of their own), so neither accumulates sequence state and both can be
// shared across flows.
const flowPayers = {
  flow1: Keypair.random(),
  flow2: Keypair.random(),
  flow3: Keypair.random(),
  flow4: Keypair.random(),
  flow5: Keypair.random(),
  flow6: Keypair.random(),
}
const sponsoredEnvelopeSigners = {
  flow5: Keypair.random(),
  flow6: Keypair.random(),
}
const TEST_RECIPIENT = Keypair.random().publicKey()
const TEST_FEE_PAYER = Keypair.random()

const MPP_SECRET_KEY = 'e2e-test-secret-key'
const sorobanServer = new SorobanServer(SOROBAN_RPC_URLS[STELLAR_TESTNET])

type ServerChargeMethod = ReturnType<typeof serverCharge>
type ClientChargeMethod = ReturnType<typeof clientCharge>

/**
 * Builds the standard server-side charge method with a fresh in-memory store.
 * Accepts an optional `feePayer` configuration to toggle sponsorship variants.
 */
function makeServerMethod(feePayer?: {
  envelopeSigner: Keypair
  feeBumpSigner?: Keypair
}): ServerChargeMethod {
  return serverCharge({
    recipient: TEST_RECIPIENT,
    currency: XLM_SAC_TESTNET,
    store: Store.memory(),
    ...(feePayer ? { feePayer } : {}),
  })
}

/**
 * Builds a charge client that wraps the signed inner tx in a
 * `FeeBumpTransaction` before returning it to the server (pull) or
 * broadcasting it itself (push). Mirrors `examples/charge-client-fee-bump.ts`.
 *
 * Used to exercise the unsponsored-with-feeBump flows the built-in
 * `clientCharge()` factory does not cover.
 */
function feeBumpChargeClient(opts: {
  payerKP: Keypair
  feeBumpKP: Keypair
  mode: 'push' | 'pull'
}): ClientChargeMethod {
  const { payerKP, feeBumpKP, mode } = opts
  return Method.toClient(chargeMethod, {
    async createCredential({ challenge }) {
      const { request } = challenge
      const { amount, currency, recipient } = request
      const network = resolveNetworkId(request.methodDetails?.network)
      const networkPassphrase = NETWORK_PASSPHRASE[network]

      const contract = new Contract(currency)
      const sourceAccount = await sorobanServer.getAccount(payerKP.publicKey())

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          contract.call(
            'transfer',
            new Address(payerKP.publicKey()).toScVal(),
            new Address(recipient).toScVal(),
            nativeToScVal(BigInt(amount), { type: 'i128' }),
          ),
        )
        .setTimeout(DEFAULT_TIMEOUT)
        .build()

      const prepared = await sorobanServer.prepareTransaction(tx)
      prepared.sign(payerKP)

      const feeBumpTx = wrapFeeBump(prepared, feeBumpKP, { networkPassphrase })
      const source = `did:pkh:${network}:${payerKP.publicKey()}`

      if (mode === 'push') {
        const result = await sorobanServer.sendTransaction(feeBumpTx)
        if (result.status !== 'PENDING') {
          throw new Error(`Broadcast failed: sendTransaction returned ${result.status}`)
        }
        await pollTransaction(sorobanServer, result.hash, {})
        const canonicalHash = result.hash.toLowerCase()
        const bindingMessage = Buffer.from(`${challenge.id}:${canonicalHash}`)
        const sourceSignature = Buffer.from(payerKP.sign(bindingMessage)).toString('hex')
        return Credential.serialize({
          challenge,
          payload: { type: 'signedHash' as const, hash: result.hash, sourceSignature },
          source,
        })
      }

      return Credential.serialize({
        challenge,
        payload: { type: 'transaction' as const, transaction: feeBumpTx.toXDR() },
        source,
      })
    },
  })
}

/**
 * Wraps an mppx server handler as a standard fetch function so the mppx client
 * can drive the full 402 -> credential -> verify flow without a real HTTP
 * server.
 */
function handlerAsFetch(
  handler: (
    request: Request,
  ) => Promise<{ status: number; challenge?: Response; withReceipt?: (r: Response) => Response }>,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const result = await handler(request)
    if (result.status === 402) {
      if (!result.challenge) {
        throw new Error(`handlerAsFetch: 402 result missing challenge: ${JSON.stringify(result)}`)
      }
      return result.challenge
    }
    if (result.withReceipt) {
      return result.withReceipt(Response.json({ message: 'paid' }, { status: result.status }))
    }
    throw new Error(`handlerAsFetch: unexpected handler result: ${JSON.stringify(result)}`)
  }
}

/**
 * Drives a full charge round-trip and returns the settled on-chain
 * transaction. Asserts the response code, receipt envelope, and that the
 * referenced tx was confirmed successfully — flow-specific envelope shape
 * (source, feeBump, signatures) is checked by each test afterward.
 */
async function runChargeFlow(opts: {
  serverMethod: ServerChargeMethod
  clientMethod: ClientChargeMethod
}): Promise<Api.GetSuccessfulTransactionResponse> {
  const serverMppx = MppxServer.create({
    secretKey: MPP_SECRET_KEY,
    methods: [opts.serverMethod],
  })
  const handler = serverMppx.charge({ amount: '1' })
  const clientMppx = MppxClient.create({
    polyfill: false,
    fetch: handlerAsFetch(handler),
    methods: [opts.clientMethod],
  })

  const response = await clientMppx.fetch('http://localhost/test')
  // mppx keeps verification-failure detail server-side and re-challenges the
  // client with a 402. Every flow in the accepts suite is expected to settle, so
  // a non-200 here is a transient testnet broadcast/propagation failure (e.g. a
  // push tx not yet confirmed on the server's RPC node). Signal it for retry
  // rather than asserting, so a momentary 402 does not fail an otherwise-valid flow.
  if (response.status !== 200) {
    throw new Error(`Charge flow did not settle: server returned ${response.status}`)
  }

  const paymentReceiptHeader = response.headers.get('Payment-Receipt')
  expect(
    paymentReceiptHeader,
    'expected Payment-Receipt header to be present on a successful charge response',
  ).not.toBeNull()
  const receipt = Receipt.deserialize(paymentReceiptHeader!)
  expect(receipt.status).toBe('success')
  expect(receipt.method).toBe('stellar')
  expect(receipt.reference).toMatch(/^[a-f0-9]{64}$/)

  // The server already confirmed settlement before returning the receipt, but the
  // public RPC is load-balanced and a re-fetch can hit a node that has not yet
  // ingested the tx (transient NOT_FOUND). Poll through that lag to a terminal state.
  const tx = await pollTransaction(sorobanServer, receipt.reference)
  expect(tx.status).toBe(Api.GetTransactionStatus.SUCCESS)
  const successful = tx as Api.GetSuccessfulTransactionResponse
  expect(successful.txHash).toEqual(receipt.reference)

  return successful
}

// Transient testnet conditions that are not flow bugs: the public RPC rejects a
// broadcast under load, or a just-broadcast tx is briefly invisible to a
// load-balanced RPC node. They warrant retrying the whole round-trip. A genuine
// rejection (e.g. enforce-mode auth failure) does not match and propagates.
const TRANSIENT_BROADCAST_ERROR =
  /sendTransaction returned ERROR|Broadcast failed|not found on-chain|NOT_FOUND|Account not found|did not settle/i

/**
 * Runs a charge round-trip, retrying the whole flow on transient testnet
 * broadcast/propagation errors. Each attempt rebuilds the server and client
 * methods so it starts from a clean store and a freshly fetched sequence.
 */
async function runChargeFlowWithRetry(
  makeOpts: () => { serverMethod: ServerChargeMethod; clientMethod: ClientChargeMethod },
  attempts = 5,
): Promise<Api.GetSuccessfulTransactionResponse> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await runChargeFlow(makeOpts())
    } catch (err) {
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      if (!TRANSIENT_BROADCAST_ERROR.test(message)) {
        throw err
      }
      // Give a momentary congestion spike time to clear before rebuilding.
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
    }
  }
  throw lastError
}

/**
 * Asserts the on-chain tx envelope is a plain Transaction (not a FeeBump)
 * signed by `expectedSource`, with exactly one signature.
 */
function expectPlainEnvelope(
  tx: Api.GetSuccessfulTransactionResponse,
  expectedSource: Keypair,
): Transaction {
  expect(tx.feeBump).toBe(false)
  const envelope = TransactionBuilder.fromXDR(
    tx.envelopeXdr,
    NETWORK_PASSPHRASE[STELLAR_TESTNET],
  ) as Transaction
  expect(envelope.source).toBe(expectedSource.publicKey())
  expect(envelope.signatures.length).toBe(1)
  expect(envelope.signatures[0].hint()).toEqual(expectedSource.signatureHint())
  return envelope
}

/**
 * Asserts the on-chain tx envelope is a FeeBumpTransaction with outer fee
 * source `feeBumpKP` and inner source `innerKP`, each with one signature.
 */
function expectFeeBumpEnvelope(
  tx: Api.GetSuccessfulTransactionResponse,
  feeBumpKP: Keypair,
  innerKP: Keypair,
): FeeBumpTransaction {
  expect(tx.feeBump).toBe(true)
  const outerEnv = TransactionBuilder.fromXDR(
    tx.envelopeXdr,
    NETWORK_PASSPHRASE[STELLAR_TESTNET],
  ) as FeeBumpTransaction
  expect(outerEnv.feeSource).toBe(feeBumpKP.publicKey())
  expect(outerEnv.signatures.length).toBe(1)
  expect(outerEnv.signatures[0].hint()).toEqual(feeBumpKP.signatureHint())

  const innerEnv = outerEnv.innerTransaction
  expect(innerEnv.source).toBe(innerKP.publicKey())
  expect(innerEnv.signatures.length).toBe(1)
  expect(innerEnv.signatures[0].hint()).toEqual(innerKP.signatureHint())
  return outerEnv
}

// Friendbot and the Soroban RPC are separate services: friendbot submits the
// funding tx via Horizon, and the RPC ingests it a few ledgers later. fundAddress
// polls the RPC immediately, so it can throw NOT_FOUND / "Account not found" even
// though funding succeeded. Retry against account visibility, tolerating the lag
// and the "already funded" error from a prior attempt that did land.
async function fundResilient(pubkey: string): Promise<void> {
  const deadlineMs = Date.now() + 90_000
  let lastError: unknown
  while (Date.now() < deadlineMs) {
    try {
      await sorobanServer.getAccount(pubkey)
      return
    } catch (err) {
      lastError = err
    }
    try {
      await sorobanServer.fundAddress(pubkey)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(
    `Funding ${pubkey} timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

describe('charge e2e (testnet)', () => {
  beforeAll(async () => {
    await Promise.all([
      ...Object.values(flowPayers).map((kp) => fundResilient(kp.publicKey())),
      ...Object.values(sponsoredEnvelopeSigners).map((kp) => fundResilient(kp.publicKey())),
      fundResilient(TEST_RECIPIENT),
      fundResilient(TEST_FEE_PAYER.publicKey()),
    ])
  }, 180_000)

  it('flow 1: push, unsponsored', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod(),
      clientMethod: clientCharge({ keypair: flowPayers.flow1, mode: 'push' }),
    }))
    expectPlainEnvelope(tx, flowPayers.flow1)
  }, 240_000)

  it('flow 2: push, unsponsored + FeeBump (client-wrapped)', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod(),
      clientMethod: feeBumpChargeClient({
        payerKP: flowPayers.flow2,
        feeBumpKP: TEST_FEE_PAYER,
        mode: 'push',
      }),
    }))
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, flowPayers.flow2)
  }, 240_000)

  it('flow 3: pull, unsponsored', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod(),
      clientMethod: clientCharge({ keypair: flowPayers.flow3 }),
    }))
    expectPlainEnvelope(tx, flowPayers.flow3)
  }, 240_000)

  it('flow 4: pull, unsponsored + FeeBump (client-wrapped)', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod(),
      clientMethod: feeBumpChargeClient({
        payerKP: flowPayers.flow4,
        feeBumpKP: TEST_FEE_PAYER,
        mode: 'pull',
      }),
    }))
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, flowPayers.flow4)
  }, 240_000)

  it('flow 5: pull, sponsored', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod({ envelopeSigner: sponsoredEnvelopeSigners.flow5 }),
      clientMethod: clientCharge({ keypair: flowPayers.flow5 }),
    }))
    expectPlainEnvelope(tx, sponsoredEnvelopeSigners.flow5)
  }, 240_000)

  it('flow 6: pull, sponsored + FeeBump', async () => {
    const tx = await runChargeFlowWithRetry(() => ({
      serverMethod: makeServerMethod({
        envelopeSigner: sponsoredEnvelopeSigners.flow6,
        feeBumpSigner: TEST_FEE_PAYER,
      }),
      clientMethod: clientCharge({ keypair: flowPayers.flow6 }),
    }))
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, sponsoredEnvelopeSigners.flow6)
  }, 240_000)
})
