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
import { StrKey } from '@stellar/stellar-sdk'
import { Mppx, Store } from 'mppx/server'
import { stellar } from '../sdk/src/channel/server/index.js'
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
