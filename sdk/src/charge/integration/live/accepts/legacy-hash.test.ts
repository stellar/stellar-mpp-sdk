import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
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
import { pollTransaction } from '../../../../shared/poll.js'
import { resolveNetworkId } from '../../../../shared/validation.js'
import { charge as chargeMethod } from '../../../Methods.js'
import { charge as serverCharge } from '../../../server/Charge.js'

// Account setup for legacy hash acceptance testing.
// Separate from the e2e suite; this is a single legacy credential test.
const TEST_PAYER = Keypair.random()
const TEST_RECIPIENT = Keypair.random().publicKey()

const MPP_SECRET_KEY = 'legacy-hash-accept-test-secret-key'
const sorobanServer = new SorobanServer(SOROBAN_RPC_URLS[STELLAR_TESTNET])

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

describe('legacy hash credential acceptance (default server)', () => {
  beforeAll(async () => {
    await Promise.all([
      sorobanServer.fundAddress(TEST_PAYER.publicKey()),
      sorobanServer.fundAddress(TEST_RECIPIENT),
    ])
  }, 30_000)

  it('default server accepts legacy hash credential and settles on-chain', async () => {
    // Create default server method (rejectUnsignedPush unset/false)
    const serverMethod = serverCharge({
      recipient: TEST_RECIPIENT,
      currency: XLM_SAC_TESTNET,
      store: Store.memory(),
      // rejectUnsignedPush defaults to false: legacy unsigned credentials accepted
    })

    // Build a real SEP-41 transfer on-chain
    const network = STELLAR_TESTNET
    const networkPassphrase = NETWORK_PASSPHRASE[network]
    const contract = new Contract(XLM_SAC_TESTNET)
    const sourceAccount = await sorobanServer.getAccount(TEST_PAYER.publicKey())

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          'transfer',
          new Address(TEST_PAYER.publicKey()).toScVal(),
          new Address(TEST_RECIPIENT).toScVal(),
          nativeToScVal(BigInt(10000000), { type: 'i128' }), // 1 XLM in stroops
        ),
      )
      .setTimeout(DEFAULT_TIMEOUT)
      .build()

    const prepared = await sorobanServer.prepareTransaction(tx)
    prepared.sign(TEST_PAYER)

    // Broadcast the real transaction
    const result = await sorobanServer.sendTransaction(prepared)
    if (result.status !== 'PENDING') {
      throw new Error(`Broadcast failed: sendTransaction returned ${result.status}`)
    }
    await pollTransaction(sorobanServer, result.hash, {})
    const canonicalHash = result.hash.toLowerCase()

    // Create a legacy client that emits type: 'hash' (unsigned)
    // to test default server acceptance
    const legacyClient = Method.toClient(chargeMethod, {
      async createCredential({ challenge }) {
        // Return legacy unsigned hash credential
        const source = `did:pkh:${network}:${TEST_PAYER.publicKey()}`
        return Credential.serialize({
          challenge,
          payload: { type: 'hash' as const, hash: result.hash },
          source,
        })
      },
    })

    // Run the charge flow with the default server accepting legacy credentials
    const serverMppx = MppxServer.create({
      secretKey: MPP_SECRET_KEY,
      methods: [serverMethod],
    })
    const handler = serverMppx.charge({ amount: '1' })
    const clientMppx = MppxClient.create({
      polyfill: false,
      fetch: handlerAsFetch(handler),
      methods: [legacyClient],
    })

    const response = await clientMppx.fetch('http://localhost/test')
    expect(response.status).toBe(200)

    const paymentReceiptHeader = response.headers.get('Payment-Receipt')
    expect(paymentReceiptHeader).not.toBeNull()
    const receipt = Receipt.deserialize(paymentReceiptHeader!)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('stellar')
    expect(receipt.reference).toBe(canonicalHash)

    // Verify the on-chain transaction is real and matches the reference
    const onChainTx = await sorobanServer.getTransaction(receipt.reference)
    expect(onChainTx.status).toBe(Api.GetTransactionStatus.SUCCESS)
    const successfulTx = onChainTx as Api.GetSuccessfulTransactionResponse
    expect(successfulTx.txHash).toEqual(receipt.reference)
  }, 120_000)
})
