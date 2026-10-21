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
import { CloseSendLimitError, SOROBAN_RPC_URLS } from '../sdk/src/index.js'
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

// Close with the latest stored commitment when a close starts on-chain.
// watchChannel only reports events from the ledger it starts at, so read the
// latest ledger, then check the channel state, and watch from that ledger on: a
// close that starts in between shows up in at least one of them.
// closeWithLatestCommitment is idempotent and reads the chain before sending,
// so every failure is handled the same way: wait, check the channel still holds
// funds, call it again. The contract accepts the close until a refund drains
// the balance, so retries continue past the waiting period while funds remain.
function closeWhenCloseStarts(feePayer: { envelopeSigner: string; feeBumpSigner?: string }) {
  const network = 'stellar:testnet'
  const retryDelayMs = 15_000
  let closing: Promise<void> | undefined

  async function reconcileClose(trigger: string) {
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
          logger.info(
            { trigger },
            'Nothing to send: channel already closed on-chain or no commitment stored',
          )
        } else {
          logger.info({ trigger, txHash }, 'Channel closed with the latest commitment')
        }
        return
      } catch (err) {
        if (err instanceof CloseSendLimitError) {
          logger.error({ trigger, err }, 'Close send limit reached; operator action required')
          return
        }
        logger.warn({ trigger, err }, 'Close with the latest commitment failed; retrying')
      }
      await sleep(retryDelayMs)
      // Stop only once the chain shows an empty channel: either a close landed
      // or the funder was refunded, and a further close would fail on-chain.
      // While the chain cannot be read, keep retrying.
      const state = await getChannelState({ channel: Env.channelContract, network }).catch(
        () => null,
      )
      if (state && state.balance === 0n) {
        logger.warn({ trigger }, 'Channel holds no funds; nothing left to close')
        return
      }
    }
  }

  function onCloseStarted(trigger: string) {
    closing ??= reconcileClose(trigger).finally(() => {
      closing = undefined
    })
  }

  function watchFrom(startLedger: number) {
    watchChannel({
      channel: Env.channelContract,
      network,
      startLedger,
      onEvent(event) {
        if (event.type === 'close') onCloseStarted('close event')
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
        if (state.closeEffectiveAtLedger !== null && state.balance > 0n) {
          onCloseStarted('startup')
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
