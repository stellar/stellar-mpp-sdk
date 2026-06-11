/**
 * Example: Close a one-way payment channel via the MPP 402 flow
 *
 * Unlike `channel-close.ts` (which calls the standalone operator `close()`
 * admin function directly), this drives the close through the MPP credential
 * path: the client sends an `action: 'close'` credential and the *server*
 * validates it, sets the per-channel `settling` marker, and broadcasts the
 * on-chain close using its configured `feePayer`.
 *
 * This exercises the server-side `doVerifyClose` path and the settling-window
 * protection that blocks new credentials during settlement.
 *
 * The server must be started with CHANNEL_ENVELOPE_SIGNER_SECRET set so it can
 * broadcast the close transaction.
 *
 * Usage:
 *   CHANNEL_CONTRACT=C... \
 *   COMMITMENT_SECRET=<64-hex> \
 *   CLOSE_AMOUNT=3000000 \
 *   SERVER_URL=http://localhost:3002 \
 *   npx tsx examples/channel-close-mpp.ts
 */

import { Keypair } from '@stellar/stellar-sdk'
import { Mppx } from 'mppx/client'
import { stellar } from '../sdk/src/channel/client/index.js'
import { parseContractAddress, parseHexKey, parseOptional } from '../sdk/src/env.js'
import { truncate } from './log-utils.js'

const CHANNEL_CONTRACT = parseContractAddress('CHANNEL_CONTRACT')
const COMMITMENT_SECRET = parseHexKey('COMMITMENT_SECRET')
const CLOSE_AMOUNT = parseOptional('CLOSE_AMOUNT', '3000000')!
const SERVER_URL = parseOptional('SERVER_URL', 'http://localhost:3002')!

const commitmentKey = Keypair.fromRawEd25519Seed(Buffer.from(COMMITMENT_SECRET, 'hex'))

console.log('═══════════════════════════════════════════════════════')
console.log('  Stellar MPP Channel — Close via MPP 402 Flow')
console.log('═══════════════════════════════════════════════════════')
console.log(`  Commitment key: ${commitmentKey.publicKey()}`)
console.log(`  Close amount:   ${CLOSE_AMOUNT} stroops (${Number(CLOSE_AMOUNT) / 1e7} XLM)`)
console.log('')

Mppx.create({
  methods: [
    stellar.channel({
      commitmentKey,
      allowedChannels: [CHANNEL_CONTRACT],
      onProgress(event) {
        const ts = new Date().toISOString().slice(11, 23)
        switch (event.type) {
          case 'challenge':
            console.log(`  [${ts}] 💳 Challenge received — channel ${truncate(event.channel)}`)
            break
          case 'signing':
            console.log(`  [${ts}] ✍️  Signing close commitment...`)
            break
          case 'signed':
            console.log(
              `  [${ts}] ✅ Close commitment signed (cumulative: ${truncate(event.cumulativeAmount)} stroops)`,
            )
            break
        }
      },
    }),
  ],
})

console.log(`Requesting ${SERVER_URL} (action: close)...\n`)

const response = await fetch(SERVER_URL, {
  context: {
    action: 'close',
    cumulativeAmount: CLOSE_AMOUNT,
  },
} as RequestInit)
const data = await response.json()

console.log(`\n--- Response (${response.status}) ---`)
console.log(JSON.stringify(data, null, 2))

if (response.ok) {
  console.log('')
  console.log('═══════════════════════════════════════════════════════')
  console.log('  ✅ Channel closed on-chain via the MPP credential flow!')
  console.log('═══════════════════════════════════════════════════════')
} else {
  process.exit(1)
}
