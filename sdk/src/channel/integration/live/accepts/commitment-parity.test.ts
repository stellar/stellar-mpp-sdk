import {
  Account,
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ALL_ZEROS,
  DEFAULT_FEE,
  NETWORK_PASSPHRASE,
  SOROBAN_RPC_URLS,
  STELLAR_TESTNET,
} from '../../../../constants.js'
import { buildCommitmentMessage } from '../../../commitment.js'

/**
 * Guards {@link buildCommitmentMessage} against contract drift.
 *
 * The server builds the commitment bytes locally. It no longer calls
 * `prepare_commitment` to get the message that it verifies signatures against.
 * This is safe only while the local encoding matches the contract encoding.
 * This test compares the two encodings against a real deployed channel.
 *
 * The RPC call previously gave that guarantee for each voucher at runtime. This
 * test gives the same guarantee one time for each CI run.
 *
 * `CHANNEL_CONTRACT` must hold the address of a one-way-channel contract on
 * testnet. The test skips when that variable is empty, so the suite still runs
 * without a deployed contract.
 */
const CHANNEL_CONTRACT = process.env.CHANNEL_CONTRACT

describe.skipIf(!CHANNEL_CONTRACT)('commitment encoding parity with the contract', () => {
  let server: rpc.Server

  beforeAll(() => {
    server = new rpc.Server(SOROBAN_RPC_URLS[STELLAR_TESTNET])
  })

  /** Calls `prepare_commitment(amount)` on-chain and returns the raw bytes. */
  async function prepareCommitmentOnChain(amount: bigint): Promise<Buffer> {
    const contract = new Contract(CHANNEL_CONTRACT!)
    const tx = new TransactionBuilder(new Account(ALL_ZEROS, '0'), {
      fee: DEFAULT_FEE,
      networkPassphrase: NETWORK_PASSPHRASE[STELLAR_TESTNET],
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
    return Buffer.from(retval.bytes())
  }

  // These amounts cover the i128 range: a boundary value, a typical voucher and
  // a large value. Encoding faults usually occur at a change of width.
  const AMOUNTS = [1n, 1_000_000n, 9_999_999_999n, 2n ** 64n]

  it.each(AMOUNTS)('matches prepare_commitment(%s) byte-for-byte', async (amount) => {
    const [onChain, local] = [
      await prepareCommitmentOnChain(amount),
      buildCommitmentMessage({
        channel: CHANNEL_CONTRACT!,
        amount,
        network: STELLAR_TESTNET,
      }),
    ]

    expect(local.toString('hex')).toBe(onChain.toString('hex'))
  })

  it('produces bytes a real keypair signature verifies against', async () => {
    // This is the full shape of the server check. Sign the message that the
    // code built locally. Then verify it with only the public key. This is what
    // verifyCommitmentSignature does, and it uses no RPC call.
    const kp = Keypair.random()
    const amount = 4_242_424n

    const message = buildCommitmentMessage({
      channel: CHANNEL_CONTRACT!,
      amount,
      network: STELLAR_TESTNET,
    })
    expect(message.toString('hex')).toBe((await prepareCommitmentOnChain(amount)).toString('hex'))

    const signature = kp.sign(message)
    expect(Keypair.fromPublicKey(kp.publicKey()).verify(message, signature)).toBe(true)
  })

  it('binds to the channel address', async () => {
    // A different channel must give different bytes. An attacker therefore
    // cannot replay a signature on a different channel.
    const other = Address.contract(Buffer.alloc(32, 7)).toString()
    const amount = 1_000_000n

    expect(
      buildCommitmentMessage({
        channel: CHANNEL_CONTRACT!,
        amount,
        network: STELLAR_TESTNET,
      }).toString('hex'),
    ).not.toBe(
      buildCommitmentMessage({ channel: other, amount, network: STELLAR_TESTNET }).toString('hex'),
    )
  })
})
