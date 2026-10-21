import { readFileSync } from 'node:fs'
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_ZEROS,
  DEFAULT_FEE,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
} from '../../../../constants.js'
import { pollTransaction } from '../../../../shared/poll.js'
import { buildCommitmentMessage } from '../../../commitment.js'

/**
 * Guards {@link buildCommitmentMessage} against contract drift.
 *
 * The server builds the commitment bytes locally. It no longer calls
 * `prepare_commitment` to get the message that it verifies signatures against.
 * This is safe only while the local encoding matches the contract encoding.
 * This test compares the two encodings against a real channel contract.
 *
 * The RPC call previously gave that guarantee for each voucher at runtime.
 * This test provides the guarantee against a live deployment, but only when it
 * runs: it belongs to the live testnet tier (`pnpm test:integration`), which
 * the default test run excludes. The guarantee that always runs under
 * `make check` is the pinned-bytes unit test in `channel/commitment.test.ts`.
 *
 * Each run deploys a throwaway channel from the WASM in `../fixtures`, so no
 * long-lived testnet contract has to be maintained. Set `CHANNEL_CONTRACT` to
 * test against a specific deployment instead.
 */
const PASSPHRASE = NETWORK_PASSPHRASE[STELLAR_TESTNET]
const CHANNEL_WASM = readFileSync(new URL('../fixtures/channel.wasm', import.meta.url))

/** Waits until the RPC sees `pubkey`, funding it through friendbot as needed. */
async function fund(server: rpc.Server, pubkey: string): Promise<Account> {
  const deadlineMs = Date.now() + 90_000
  let lastError: unknown
  while (Date.now() < deadlineMs) {
    try {
      return await server.getAccount(pubkey)
    } catch (err) {
      lastError = err
    }
    try {
      await server.fundAddress(pubkey)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(
    `Funding ${pubkey} timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

/** Prepares, signs and submits one Soroban operation, returning its result. */
async function submit(
  server: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(signer.publicKey())
  const tx = new TransactionBuilder(account, { fee: DEFAULT_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(60)
    .build()
  const prepared = await server.prepareTransaction(tx)
  prepared.sign(signer)
  const sent = await server.sendTransaction(prepared)
  if (sent.status !== 'PENDING') {
    throw new Error(`sendTransaction returned ${sent.status}: ${sent.errorResult?.toXdr('base64')}`)
  }
  return pollTransaction(server, sent.hash) as Promise<rpc.Api.GetSuccessfulTransactionResponse>
}

/**
 * Uploads the fixture WASM and opens an empty channel. The deployer is also the
 * funder, so the constructor's `from` authorization comes from the transaction
 * signature and no separate auth entry is needed.
 */
async function deployChannel(server: rpc.Server): Promise<string> {
  const deployer = Keypair.random()
  await fund(server, deployer.publicKey())

  await submit(server, deployer, Operation.uploadContractWasm({ wasm: CHANNEL_WASM }))

  const created = await submit(
    server,
    deployer,
    Operation.createCustomContract({
      address: new Address(deployer.publicKey()),
      wasmHash: hash(CHANNEL_WASM),
      constructorArgs: [
        nativeToScVal(Asset.native().contractId(PASSPHRASE), { type: 'address' }),
        nativeToScVal(deployer.publicKey(), { type: 'address' }),
        nativeToScVal(Buffer.alloc(32, 1), { type: 'bytes' }),
        nativeToScVal(Keypair.random().publicKey(), { type: 'address' }),
        nativeToScVal(0n, { type: 'i128' }),
        nativeToScVal(1, { type: 'u32' }),
      ],
    }),
  )
  if (!created.returnValue) throw new Error('createCustomContract returned no address')
  return Address.fromScVal(created.returnValue).toString()
}

describe('commitment encoding parity with the contract', () => {
  let server: rpc.Server
  let channel: string

  beforeAll(async () => {
    server = new rpc.Server(SOROBAN_RPC_URLS[STELLAR_TESTNET])
    channel = process.env.CHANNEL_CONTRACT || (await deployChannel(server))
  }, 180_000)

  /** Calls `prepare_commitment(amount)` on-chain and returns the raw bytes. */
  async function prepareCommitmentOnChain(amount: bigint): Promise<Buffer> {
    const contract = new Contract(channel)
    const tx = new TransactionBuilder(new Account(ALL_ZEROS, '0'), {
      fee: DEFAULT_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(contract.call('prepare_commitment', nativeToScVal(amount, { type: 'i128' })))
      .setTimeout(30)
      .build()

    const sim = await server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`prepare_commitment simulation failed: ${sim.error}`)
    }
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval
    if (!retval) throw new Error('prepare_commitment returned no value')
    return Buffer.from(xdr.expectUnionVariant(retval, 'scvBytes').bytes.toBytes())
  }

  // These amounts cover the i128 range: a boundary value, a typical voucher and
  // a large value. Encoding faults usually occur at a change of width.
  const AMOUNTS = [1n, 1_000_000n, 9_999_999_999n, 2n ** 64n]

  it.each(AMOUNTS)('matches prepare_commitment(%s) byte-for-byte', async (amount) => {
    const [onChain, local] = [
      await prepareCommitmentOnChain(amount),
      buildCommitmentMessage({ channel, amount, network: STELLAR_TESTNET }),
    ]

    expect(Buffer.from(local).toString('hex')).toBe(onChain.toString('hex'))
  })

  it('produces bytes a real keypair signature verifies against', async () => {
    // This is the full shape of the server check. Sign the message that the
    // code built locally. Then verify it with only the public key. This is what
    // verifyCommitmentSignature does, and it uses no RPC call.
    const kp = Keypair.random()
    const amount = 4_242_424n

    const message = buildCommitmentMessage({ channel, amount, network: STELLAR_TESTNET })
    expect(Buffer.from(message).toString('hex')).toBe(
      (await prepareCommitmentOnChain(amount)).toString('hex'),
    )

    const signature = kp.sign(message)
    expect(Keypair.fromPublicKey(kp.publicKey()).verify(message, signature)).toBe(true)
  })

  it('binds to the channel address', async () => {
    // A different channel must give different bytes. An attacker therefore
    // cannot replay a signature on a different channel.
    const other = Address.contract(Buffer.alloc(32, 7)).toString()
    const amount = 1_000_000n

    expect(
      Buffer.from(buildCommitmentMessage({ channel, amount, network: STELLAR_TESTNET })).toString(
        'hex',
      ),
    ).not.toBe(
      Buffer.from(
        buildCommitmentMessage({ channel: other, amount, network: STELLAR_TESTNET }),
      ).toString('hex'),
    )
  })
})
