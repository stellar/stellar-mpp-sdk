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

// All flows share TEST_PAYER so we only fund one payer account per suite run.
// Consequence: tests are NOT fully independent — the payer's sequence advances
// between flows, and a tx failure mid-broadcast can surface as a sequence or
// balance error in a later flow. If a test fails unexpectedly, re-run the
// whole file rather than isolating a single `it()`.
const TEST_PAYER = Keypair.random()
const TEST_RECIPIENT = Keypair.random().publicKey()
const TEST_ENVELOPE_SIGNER = Keypair.random()
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
  expect(response.status).toBe(200)

  const paymentReceiptHeader = response.headers.get('Payment-Receipt')
  expect(
    paymentReceiptHeader,
    'expected Payment-Receipt header to be present on a successful charge response',
  ).not.toBeNull()
  const receipt = Receipt.deserialize(paymentReceiptHeader!)
  expect(receipt.status).toBe('success')
  expect(receipt.method).toBe('stellar')
  expect(receipt.reference).toMatch(/^[a-f0-9]{64}$/)

  const tx = await sorobanServer.getTransaction(receipt.reference)
  expect(tx.status).toBe(Api.GetTransactionStatus.SUCCESS)
  const successful = tx as Api.GetSuccessfulTransactionResponse
  expect(successful.txHash).toEqual(receipt.reference)

  return successful
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

describe('charge e2e (testnet)', () => {
  beforeAll(async () => {
    await Promise.all([
      sorobanServer.fundAddress(TEST_PAYER.publicKey()),
      sorobanServer.fundAddress(TEST_RECIPIENT),
      sorobanServer.fundAddress(TEST_ENVELOPE_SIGNER.publicKey()),
      sorobanServer.fundAddress(TEST_FEE_PAYER.publicKey()),
    ])
  }, 30_000)

  it('flow 1: push, unsponsored', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod(),
      clientMethod: clientCharge({ keypair: TEST_PAYER, mode: 'push' }),
    })
    expectPlainEnvelope(tx, TEST_PAYER)
  }, 120_000)

  it('flow 2: push, unsponsored + FeeBump (client-wrapped)', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod(),
      clientMethod: feeBumpChargeClient({
        payerKP: TEST_PAYER,
        feeBumpKP: TEST_FEE_PAYER,
        mode: 'push',
      }),
    })
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, TEST_PAYER)
  }, 120_000)

  it('flow 3: pull, unsponsored', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod(),
      clientMethod: clientCharge({ keypair: TEST_PAYER }),
    })
    expectPlainEnvelope(tx, TEST_PAYER)
  }, 120_000)

  it('flow 4: pull, unsponsored + FeeBump (client-wrapped)', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod(),
      clientMethod: feeBumpChargeClient({
        payerKP: TEST_PAYER,
        feeBumpKP: TEST_FEE_PAYER,
        mode: 'pull',
      }),
    })
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, TEST_PAYER)
  }, 120_000)

  it('flow 5: pull, sponsored', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod({ envelopeSigner: TEST_ENVELOPE_SIGNER }),
      clientMethod: clientCharge({ keypair: TEST_PAYER }),
    })
    expectPlainEnvelope(tx, TEST_ENVELOPE_SIGNER)
  }, 120_000)

  it('flow 6: pull, sponsored + FeeBump', async () => {
    const tx = await runChargeFlow({
      serverMethod: makeServerMethod({
        envelopeSigner: TEST_ENVELOPE_SIGNER,
        feeBumpSigner: TEST_FEE_PAYER,
      }),
      clientMethod: clientCharge({ keypair: TEST_PAYER }),
    })
    expectFeeBumpEnvelope(tx, TEST_FEE_PAYER, TEST_ENVELOPE_SIGNER)
  }, 120_000)
})
