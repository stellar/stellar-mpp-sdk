/**
 * Example: Close a one-way payment channel on-chain
 *
 * Signs a commitment for the given cumulative amount, then calls the
 * contract's close() function to:
 *   1. Transfer the committed amount to the recipient
 *   2. Auto-refund the remaining balance to the funder
 *
 * This demo plays both roles: it holds the funder's commitment key to produce
 * the signature. A real recipient never has that key. It passes the amount and
 * signature from the latest voucher it accepted to `close()`.
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

import { Keypair } from '@stellar/stellar-sdk'
import { buildCommitmentMessage } from '../sdk/src/channel/commitment.js'
import { close } from '../sdk/src/channel/server/index.js'
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
console.log(`  Amount: ${AMOUNT} (token base units)`)
console.log(`  Close key: ${closeKey.publicKey()}`)
console.log('')

// Step 1: Build the commitment message locally. The amount, channel and network
// fully determine it, so no RPC call is needed.
console.log('1. Building commitment message...')
const commitmentBytes = buildCommitmentMessage({
  channel: CHANNEL_CONTRACT,
  amount: AMOUNT,
  network: NETWORK,
})
console.log(`   Commitment: ${Buffer.from(commitmentBytes).toString('hex').slice(0, 40)}...`)

// Step 2: Sign the commitment with the funder's ed25519 commitment key (demo only)
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
