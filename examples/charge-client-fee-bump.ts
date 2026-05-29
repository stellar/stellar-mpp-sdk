/**
 * Example: Stellar MPP Client with FeeBump
 *
 * Demonstrates client-side FeeBumpTransaction wrapping for the unsponsored
 * charge flows:
 *   - pull + FeeBump (default): sends fee-bumped XDR for server to broadcast
 *   - push + FeeBump: client broadcasts the fee-bumped tx, sends hash
 *
 * Usage (pull + FeeBump):
 *   STELLAR_SECRET=S... FEE_BUMP_SECRET=S... \
 *     SERVER_URL=http://localhost:3000 \
 *     npx tsx examples/charge-client-fee-bump.ts
 *
 * Usage (push + FeeBump):
 *   STELLAR_SECRET=S... FEE_BUMP_SECRET=S... CHARGE_CLIENT_MODE=push \
 *     SERVER_URL=http://localhost:3000 \
 *     npx tsx examples/charge-client-fee-bump.ts
 *
 * Run against the standard charge-server.ts (no feePayer env vars needed).
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk'
import { Credential, Method } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge as chargeMethod, fromBaseUnits } from '../sdk/src/charge/Methods.js'
import { SOROBAN_RPC_URLS, NETWORK_PASSPHRASE, DEFAULT_TIMEOUT } from '../sdk/src/constants.js'
import { resolveNetworkId } from '../sdk/src/shared/validation.js'
import { wrapFeeBump } from '../sdk/src/shared/fee-bump.js'
import { pollTransaction } from '../sdk/src/shared/poll.js'
import { Env } from './config/charge-client-fee-bump.js'

const keypair = Keypair.fromSecret(Env.stellarSecret)
const feeBumpKP = Keypair.fromSecret(Env.feeBumpSecret)
const mode = Env.chargeClientMode

console.log(`Using Stellar account: ${keypair.publicKey()}`)
console.log(`Using fee bump key:    ${feeBumpKP.publicKey()}`)
console.log(`Mode: ${mode}+fee-bump\n`)

Mppx.create({
  methods: [
    Method.toClient(chargeMethod, {
      async createCredential({ challenge }) {
        const { request } = challenge
        const { amount, currency, recipient } = request

        const network = resolveNetworkId(request.methodDetails?.network)
        const rpcUrl = SOROBAN_RPC_URLS[network]
        const networkPassphrase = NETWORK_PASSPHRASE[network]
        const server = new rpc.Server(rpcUrl)

        const ts = () => new Date().toISOString().slice(11, 23)
        console.log(`[${ts()}] 💳 Challenge — ${fromBaseUnits(amount, 7)} to ${recipient}`)

        // Build SAC transfer(from, to, amount) invocation
        const contract = new Contract(currency)
        const sourceAccount = await server.getAccount(keypair.publicKey())

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(
            contract.call(
              'transfer',
              new Address(keypair.publicKey()).toScVal(),
              new Address(recipient).toScVal(),
              nativeToScVal(BigInt(amount), { type: 'i128' }),
            ),
          )
          .setTimeout(DEFAULT_TIMEOUT)
          .build()

        const prepared = await server.prepareTransaction(tx)

        console.log(`[${ts()}] ✍️  Signing...`)
        prepared.sign(keypair)

        // Wrap the signed tx in a FeeBumpTransaction
        const feeBumpTx = wrapFeeBump(prepared, feeBumpKP, { networkPassphrase })
        console.log(
          `[${ts()}] 📦 Wrapped in FeeBumpTransaction (fee payer: ${feeBumpKP.publicKey().slice(0, 8)}...)`,
        )

        const source = `did:pkh:${network}:${keypair.publicKey()}`

        if (mode === 'push') {
          // Client broadcasts the fee-bumped tx; server verifies the on-chain hash
          console.log(`[${ts()}] 📡 Broadcasting fee-bumped tx...`)
          const result = await server.sendTransaction(feeBumpTx)
          if (result.status !== 'PENDING') {
            throw new Error(`Broadcast failed: sendTransaction returned ${result.status}`)
          }
          console.log(`[${ts()}] ⏳ Confirming ${result.hash.slice(0, 12)}...`)
          await pollTransaction(server, result.hash, {})
          console.log(`[${ts()}] 🎉 Confirmed: ${result.hash}`)

          return Credential.serialize({
            challenge,
            payload: { type: 'hash' as const, hash: result.hash },
            source,
          })
        }

        // Pull mode: send fee-bumped XDR for server to broadcast as-is
        const feeBumpXdr = feeBumpTx.toXdr()
        console.log(`[${ts()}] ✅ Sending fee-bumped XDR (${feeBumpXdr.length} bytes)`)

        return Credential.serialize({
          challenge,
          payload: { type: 'transaction' as const, transaction: feeBumpXdr },
          source,
        })
      },
    }),
  ],
})

const SERVER_URL = Env.serverUrl
console.log(`\nRequesting ${SERVER_URL}...\n`)
const response = await fetch(SERVER_URL)
const data = await response.json()

console.log(`\n--- Response (${response.status}) ---`)
console.log(JSON.stringify(data, null, 2))
