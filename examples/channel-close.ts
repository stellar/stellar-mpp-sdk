/**
 * Example: Close a one-way payment channel on-chain
 *
 * Generates a commitment signature for the given cumulative amount,
 * then calls the contract's close() function to:
 *   1. Transfer the committed amount to the recipient
 *   2. Auto-refund the remaining balance to the funder
 *
 * Outputs the transaction hash for verification on Stellar Expert.
 *
 * Usage:
 *   CHANNEL_CONTRACT=C... \
 *   COMMITMENT_SECRET=<64-hex> \
 *   CLOSE_SECRET=S... \
 *   AMOUNT=2000000 \
 *   npx tsx examples/channel-close.ts
 */

import { Contract, Keypair, TransactionBuilder, nativeToScVal, rpc } from '@stellar/stellar-sdk'
import { close } from '../sdk/src/channel/server/index.js'
import { NETWORK_PASSPHRASE, SOROBAN_RPC_URLS } from '../sdk/src/constants.js'
import {
  parseContractAddress,
  parseHexKey,
  parseOptional,
  parseStellarSecretKey,
} from '../sdk/src/env.js'

const CHANNEL_CONTRACT = parseContractAddress('CHANNEL_CONTRACT')
const COMMITMENT_SECRET = parseHexKey('COMMITMENT_SECRET')
const CLOSE_SECRET = parseStellarSecretKey('CLOSE_SECRET')
const AMOUNT = BigInt(parseOptional('AMOUNT', '2000000')!)
const NETWORK = 'stellar:testnet' as const

const commitmentKey = Keypair.fromRawEd25519Seed(Buffer.from(COMMITMENT_SECRET, 'hex'))
const closeKey = Keypair.fromSecret(CLOSE_SECRET)

console.log(`Closing channel ${CHANNEL_CONTRACT}`)
console.log(`  Amount: ${AMOUNT} stroops (${Number(AMOUNT) / 1e7} XLM)`)
console.log(`  Close key: ${closeKey.publicKey()}`)
console.log('')

// Step 1: Simulate prepare_commitment to get commitment bytes
console.log('1. Simulating prepare_commitment...')
const server = new rpc.Server(SOROBAN_RPC_URLS[NETWORK])
const contract = new Contract(CHANNEL_CONTRACT)

const account = await server.getAccount(closeKey.publicKey())
const simTx = new TransactionBuilder(account, {
  fee: '100',
  networkPassphrase: NETWORK_PASSPHRASE[NETWORK],
})
  .addOperation(contract.call('prepare_commitment', nativeToScVal(AMOUNT, { type: 'i128' })))
  .setTimeout(30)
  .build()

const simResult = await server.simulateTransaction(simTx)
if (!rpc.Api.isSimulationSuccess(simResult)) {
  console.error('❌ Simulation failed:', 'error' in simResult ? simResult.error : 'unknown')
  process.exit(1)
}

const retval = simResult.result!.retval
if (retval.type !== 'scvBytes') {
  console.error(`❌ prepare_commitment did not return bytes (got ${retval.type})`)
  process.exit(1)
}
const commitmentBytes = retval.value.value
console.log(`   Commitment: ${Buffer.from(commitmentBytes).toString('hex').slice(0, 40)}...`)

// Step 2: Sign the commitment with the ed25519 key
console.log('2. Signing commitment...')
const signature = commitmentKey.sign(Buffer.from(commitmentBytes))
console.log(`   Signature: ${Buffer.from(signature).toString('hex').slice(0, 40)}...`)

// Step 3: Submit close transaction on-chain
console.log('3. Submitting close transaction...')
const txHash = await close({
  channel: CHANNEL_CONTRACT,
  amount: AMOUNT,
  signature,
  feePayer: { envelopeSigner: closeKey },
  network: NETWORK,
})

console.log('')
console.log('═══════════════════════════════════════════════════════')
console.log('  ✅ Channel closed on-chain!')
console.log(`  Transaction: ${txHash}`)
console.log(`  Verify:      https://stellar.expert/explorer/testnet/tx/${txHash}`)
console.log('═══════════════════════════════════════════════════════')
