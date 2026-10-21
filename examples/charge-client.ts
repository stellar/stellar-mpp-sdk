/**
 * Example: Stellar MPP Client
 *
 * Automatically handles 402 Payment Required responses by paying
 * via Soroban SEP-41 transfer on Stellar testnet.
 *
 * Usage:
 *   STELLAR_SECRET=SYOUR_SECRET_KEY npx tsx examples/charge-client.ts
 */

import { Keypair } from '@stellar/stellar-sdk'
import { Mppx } from 'mppx/client'
import { stellar } from '../sdk/src/charge/client/index.js'
import { Env } from './config/charge-client.js'
import { truncate } from './log-utils.js'

const keypair = Keypair.fromSecret(Env.stellarSecret)
console.log(`Using Stellar account: ${keypair.publicKey()}`)

// Polyfill global fetch with automatic 402 handling
Mppx.create({
  methods: [
    stellar.charge({
      keypair,
      mode: Env.chargeClientMode,
      network: Env.network,
      onProgress(event) {
        const ts = new Date().toISOString().slice(11, 23)
        switch (event.type) {
          case 'challenge':
            console.log(
              `[${ts}] 💳 Challenge received — ${truncate(event.amount)} to ${truncate(event.recipient)}`,
            )
            break
          case 'signing':
            console.log(`[${ts}] ✍️  Signing transaction...`)
            break
          case 'signed':
            console.log(`[${ts}] ✅ Transaction signed (${event.transaction.length} bytes XDR)`)
            break
          case 'paying':
            console.log(`[${ts}] 📡 Broadcasting transaction...`)
            break
          case 'confirming':
            console.log(`[${ts}] ⏳ Confirming tx ${truncate(event.hash)}`)
            break
          case 'paid':
            console.log(`[${ts}] 🎉 Payment confirmed: ${truncate(event.hash)}`)
            break
        }
      },
    }),
  ],
})

// Make a request to the payment-gated server
const SERVER_URL = Env.serverUrl

console.log(`\nRequesting ${SERVER_URL}...\n`)
const response = await fetch(SERVER_URL)
const data = await response.json()

console.log(`\n--- Response (${response.status}) ---`)
console.log(JSON.stringify(data, null, 2))
