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
 * Contract-drift guard for {@link buildCommitmentMessage}.
 *
 * The server no longer calls `prepare_commitment` to obtain the message it
 * verifies signatures against — it builds those bytes locally. That is only
 * safe while the local encoding agrees with the contract's, so this test
 * compares them against a real deployed channel.
 *
 * Asking the contract was the original justification for the RPC call. This
 * test is what replaces that guarantee: it moves the check from every voucher
 * at runtime to once per CI run.
 *
 * Requires `CHANNEL_CONTRACT` to point at a deployed one-way-channel contract
 * on testnet. Skips when unset so the suite stays runnable without one.
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

  // Spread across the i128 range: a boundary value, a typical voucher, and a
  // large one, since encoding bugs tend to hide at width transitions.
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
    // End-to-end shape of the server's check: sign the locally-built message,
    // verify with only the public key — exactly what verifyCommitmentSignature
    // does, with no RPC involved in the verification itself.
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
    // A different channel must produce different bytes, so a signature cannot
    // be replayed across channels.
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
