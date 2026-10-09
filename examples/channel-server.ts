/**
 * Example: Stellar MPP Channel Server
 *
 * Charges per request via off-chain one-way payment channel commitments.
 * Uses Express with security headers (helmet, rate limiting).
 *
 * Prerequisites:
 *   - A deployed one-way-channel contract on testnet
 *   - The commitment public key used when deploying the channel
 *
 * Usage:
 *   CHANNEL_CONTRACT=CABC... COMMITMENT_PUBKEY=b83e... npx tsx examples/channel-server.ts
 *
 * Then test with:
 *   COMMITMENT_SECRET=73b5... npx tsx examples/channel-client.ts
 */

import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import pino from 'pino'
import pinoHttp from 'pino-http'
import { setTimeout as sleep } from 'node:timers/promises'
import { StrKey, rpc } from '@stellar/stellar-sdk'
import { Mppx, Store } from 'mppx/server'
import { SOROBAN_RPC_URLS } from '../sdk/src/index.js'
import {
  closeWithLatestCommitment,
  getChannelState,
  stellar,
  watchChannel,
} from '../sdk/src/channel/server/index.js'
import { Env } from './config/channel-server.js'

const logger = pino({ level: Env.logLevel })
const app = express()

// Security middleware
app.set('trust proxy', Env.trustProxy)
app.use(helmet())
app.use(rateLimit({ windowMs: Env.rateLimitWindowMs, max: Env.rateLimitMax }))
app.use(pinoHttp({ logger }))
app.use(express.json())

// Convert the raw ed25519 public key (hex) to a Stellar G... address for verification
const commitmentPublicKeyG = StrKey.encodeEd25519PublicKey(Buffer.from(Env.commitmentPubkey, 'hex'))

// Store.memory() keeps the example self-contained, but it starts empty after a
// restart, losing the commitments the startup close check below needs. Use a
// persistent Store.AtomicStore such as Store.redis() for restart recovery.
const store = Store.memory()

const mppx = Mppx.create({
  secretKey: Env.mppSecretKey,
  methods: [
    stellar.channel({
      channel: Env.channelContract,
      commitmentKey: commitmentPublicKeyG,
      store,
      network: 'stellar:testnet',
      ...(Env.feePayer ? { feePayer: Env.feePayer } : {}),
      logger,
    }),
  ],
})

// Close with the latest stored commitment when a close starts on-chain, before
// the refund waiting period ends. watchChannel only reports events from the
// ledger it starts at, so read the latest ledger, then check the channel state,
// and watch from that ledger on: a close that starts in between shows up in at
// least one of them. closeWithLatestCommitment is idempotent and reads the
// chain before sending, so every failure is handled the same way: wait, check
// the waiting period is still running, call it again.
function closeWhenCloseStarts(feePayer: { envelopeSigner: string; feeBumpSigner?: string }) {
  const network = 'stellar:testnet'
  const retryDelayMs = 15_000
  let closing: Promise<void> | undefined

  async function reconcileClose(trigger: string, effectiveAtLedger: number) {
    for (;;) {
      try {
        const txHash = await closeWithLatestCommitment({
          store,
          channel: Env.channelContract,
          feePayer,
          network,
          logger,
        })
        if (txHash === null) {
          logger.info({ trigger }, 'Channel already closed on-chain with the latest commitment')
        } else {
          logger.info({ trigger, txHash }, 'Channel closed with the latest commitment')
        }
        return
      } catch (err) {
        if (err instanceof Error && err.message.includes('Close send limit reached')) {
          logger.error({ trigger, err }, 'Close send limit reached; operator action required')
          return
        }
        logger.warn({ trigger, err }, 'Close with the latest commitment failed; retrying')
      }
      await sleep(retryDelayMs)
      // Stop only once the chain shows the waiting period ended. While the
      // chain cannot be read, keep retrying.
      const state = await getChannelState({ channel: Env.channelContract, network }).catch(
        () => null,
      )
      if (state && state.closeStatusLedger >= effectiveAtLedger) {
        logger.error({ trigger }, 'Refund waiting period ended before the close landed')
        return
      }
    }
  }

  function onCloseStarted(trigger: string, effectiveAtLedger: number) {
    closing ??= reconcileClose(trigger, effectiveAtLedger).finally(() => {
      closing = undefined
    })
  }

  function watchFrom(startLedger: number) {
    watchChannel({
      channel: Env.channelContract,
      network,
      startLedger,
      onEvent(event) {
        if (event.type === 'close' && event.effectiveAtLedger > event.ledger) {
          onCloseStarted('close event', event.effectiveAtLedger)
        }
      },
      onError: (err) => logger.warn({ err }, 'Channel watcher poll failed'),
    })
  }

  // Retry until both reads succeed: a close that is already pending is only
  // found by the state check.
  async function checkAtStartup() {
    const server = new rpc.Server(SOROBAN_RPC_URLS[network])
    for (;;) {
      try {
        const { sequence } = await server.getLatestLedger()
        const state = await getChannelState({ channel: Env.channelContract, network })
        if (
          state.closeEffectiveAtLedger !== null &&
          state.closeStatusLedger < state.closeEffectiveAtLedger
        ) {
          onCloseStarted('startup', state.closeEffectiveAtLedger)
        }
        watchFrom(sequence)
        return
      } catch (err) {
        logger.warn({ err }, 'Startup channel state check failed; retrying')
        await sleep(retryDelayMs)
      }
    }
  }

  void checkAtStartup()
}

// Main MPP channel endpoint — catch-all so every route is payment-gated (matches original behavior)
app.use(async (req, res) => {
  const webReq = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: new Headers(req.headers as Record<string, string>),
  })

  const result = await mppx.channel({
    amount: '0.1',
    description: 'Channel-gated API access',
  })(webReq)

  if (result.status === 402) {
    const challenge = result.challenge
    res.status(challenge.status)
    challenge.headers.forEach((v, k) => res.setHeader(k, v))
    res.send(await challenge.text())
    return
  }

  const receipt = result.withReceipt(
    Response.json({
      message: 'Payment verified via channel commitment — here is your content.',
      timestamp: new Date().toISOString(),
      note: 'No on-chain transaction was needed for this payment!',
    }),
  )
  res.status(receipt.status)
  receipt.headers.forEach((v, k) => res.setHeader(k, v))
  res.send(await receipt.text())
})

app.listen(Env.port, () => {
  logger.info(
    {
      port: Env.port,
      channel: Env.channelContract,
      commitmentKey: Env.commitmentPubkey.slice(0, 16),
    },
    'Stellar MPP Channel server started',
  )
})

if (Env.feePayer) closeWhenCloseStarts(Env.feePayer)
