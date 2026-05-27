# @stellar/mpp

Stellar blockchain payment method for the [Machine Payments Protocol (MPP)](https://mpp.dev). Enables machine-to-machine payments using Soroban SEP-41 token transfers on the Stellar network, with optional support for [one-way payment channels](https://github.com/stellar-experimental/one-way-channel) for high-frequency off-chain payments.

## Specification

The charge payment mode implements the [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00) specification ([source](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/stellar/draft-stellar-charge-00.md)), which defines the `stellar` payment method with a `charge` intent for one-time SEP-41 token transfers under the HTTP Payment Authentication scheme.

## Payment modes

### Charge (one-time transfers)

Each payment is a Soroban SEP-41 `transfer` settled on-chain individually.

```
Client                          Server                         Stellar
  |                               |                               |
  |  GET /resource                |                               |
  |------------------------------>|                               |
  |                               |                               |
  |  402 Payment Required         |                               |
  |  (challenge: pay 0.01 USDC)   |                               |
  |<------------------------------|                               |
  |                               |                               |
  |  prepareTransaction ----------------- (simulate) ------------>|
  |  Sign SEP-41 transfer          |                               |
  |  Send credential (XDR)        |                               |
  |------------------------------>|                               |
  |                               |  sendTransaction ------------>|
  |                               |  getTransaction (poll) ------>|
  |  200 OK + data                |                               |
  |<------------------------------|                               |
```

Two credential modes:

- **Pull** (default) — client prepares the transaction, server submits it:
  - _Sponsored_ (`feePayer` configured on server): client signs only Soroban auth entries using an all-zeros placeholder source; server rebuilds the tx with its own account as source, signs, and broadcasts
  - _Unsponsored_: client builds and signs the full transaction; server broadcasts as-is
- **Push** — client broadcasts the transaction itself, sends the tx hash for server verification (not compatible with `feePayer`)

### Channel (off-chain commitments)

Uses a [one-way payment channel](https://github.com/stellar-experimental/one-way-channel) contract. The funder deposits tokens into a channel once, then makes many off-chain payments by signing cumulative commitments — no per-payment on-chain transactions.

```
Client (Funder)                 Server (Recipient)                Stellar
  |                               |                                  |
  |  [Channel opened on-chain     |                                  |
  |   with initial deposit]       |                                  |
  |  (see "open" action below)    |                                  |
  |                               |                                  |
  |  GET /resource                |                                  |
  |------------------------------>|                                  |
  |                               |                                  |
  |  402 Payment Required         |                                  |
  |  (pay 1 XLM, cumulative: 0)   |                                  |
  |<------------------------------|                                  |
  |                               |                                  |
  |  simulate prepare_commitment------------------------------------>|
  |  Sign commitment off-chain    |                                  |
  |  (cumulative: 1 XLM + sig)    |                                  |
  |------------------------------>|                                  |
  |                               |  simulate prepare_commitment --->|
  |                               |  Verify ed25519 signature        |
  |  200 OK + data                |                                  |
  |<------------------------------|                                  |
  |                               |                                  |
  |  GET /resource (again)        |                                  |
  |------------------------------>|                                  |
  |                               |                                  |
  |  402 (pay 1 XLM,              |                                  |
  |   cumulative: 1 XLM)          |                                  |
  |<------------------------------|                                  |
  |                               |                                  |
  |  simulate prepare_commitment------------------------------------>|
  |  Sign commitment              |                                  |
  |  (cumulative: 2 XLM + sig)    |                                  |
  |------------------------------>|                                  |
  |                               |  simulate prepare_commitment --->|
  |                               |  Verify, 200 OK                  |
  |<------------------------------|                                  |
  |                               |                                  |
  |                               |  [close channel when convenient] |
  |                               |  sendTransaction (close) ------->|
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10.33+ (via [corepack](https://nodejs.org/api/corepack.html))

```bash
corepack enable
```

## Install

```bash
npm install @stellar/mpp @stellar/stellar-sdk mppx viem
```

`@stellar/stellar-sdk` and `mppx` are peer dependencies of `@stellar/mpp` — you must install compatible versions alongside it. `mppx` 0.6.x in turn requires `viem` (`>=2.50.4`) as a peer dependency, so install it too.

Only import the subpath you need to keep your bundle small:

```
# Pick the import for your use case:
import { stellar } from '@stellar/mpp/charge/server' // charge server only
import { stellar } from '@stellar/mpp/charge/client' // charge client only
import { stellar } from '@stellar/mpp/channel/server' // channel server only
import { stellar } from '@stellar/mpp/channel/client' // channel client only
import { parsePort } from '@stellar/mpp/env' // env helpers only
import { USDC_SAC_TESTNET } from '@stellar/mpp' // constants, schemas, error types
```

## Quick start

### Server (charge)

```ts
import { Mppx, stellar } from '@stellar/mpp/charge/server'
import { USDC_SAC_TESTNET } from '@stellar/mpp'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    stellar.charge({
      recipient: process.env.STELLAR_RECIPIENT!, // your Stellar public key (G...)
      currency: USDC_SAC_TESTNET,
      network: 'testnet',
    }),
  ],
})

// Express (example servers use helmet and rate limiting)
export async function handler(request: Request) {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'Premium API access',
  })(request)

  if (result.status === 402) return result.challenge

  return result.withReceipt(Response.json({ data: 'paid content here' }))
}
```

### Client (charge)

```ts
import { Keypair } from '@stellar/stellar-sdk'
import { Mppx, stellar } from '@stellar/mpp/charge/client'

// Polyfills global fetch — 402 responses are handled automatically
Mppx.create({
  methods: [
    stellar.charge({
      keypair: Keypair.fromSecret('S...'),
    }),
  ],
})

const response = await fetch('https://api.example.com/paid-resource')
const data = await response.json()
```

### Server (channel)

```ts
import { Mppx, stellar, Store } from '@stellar/mpp/channel/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    stellar.channel({
      channel: 'CABC...', // deployed one-way-channel contract address
      commitmentKey: 'GFUNDER...', // ed25519 public key for verifying commitments
      store: Store.memory(), // tracks cumulative amounts + replay protection
      network: 'testnet',
    }),
  ],
})

export async function handler(request: Request) {
  const result = await mppx.channel({
    amount: '1', // 1 XLM per request (human-readable)
    description: 'API call',
  })(request)

  if (result.status === 402) return result.challenge

  return result.withReceipt(Response.json({ data: 'paid content here' }))
}
```

### Client (channel)

```ts
import { Keypair } from '@stellar/stellar-sdk'
import { Mppx, stellar } from '@stellar/mpp/channel/client'

Mppx.create({
  methods: [
    stellar.channel({
      commitmentKey: Keypair.fromSecret('S...'), // ed25519 key matching the channel's commitment_key
    }),
  ],
})

const response = await fetch('https://api.example.com/paid-resource')
const data = await response.json()
```

## API

### Exports

| Path                          | Exports                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@stellar/mpp`                | `ChargeMethods`, `ChannelMethods`, constants (`USDC_SAC_TESTNET`, `XLM_SAC_MAINNET`, etc.), `toBaseUnits`, `fromBaseUnits`, `resolveKeypair`, `Env`, `Logger` (type), error types (`StellarMppError`, `PaymentVerificationError`, `ChannelVerificationError`, `SettlementError`) |
| `@stellar/mpp/charge`         | `charge` (method schema)                                                                                                                                                                                                                                                         |
| `@stellar/mpp/charge/client`  | `stellar`, `charge`, `Mppx`                                                                                                                                                                                                                                                      |
| `@stellar/mpp/charge/server`  | `stellar`, `charge`, `Mppx`, `Store`, `Expires`, `resolveKeypair`                                                                                                                                                                                                                |
| `@stellar/mpp/channel`        | `channel` (method schema)                                                                                                                                                                                                                                                        |
| `@stellar/mpp/channel/client` | `stellar`, `channel`, `Mppx`                                                                                                                                                                                                                                                     |
| `@stellar/mpp/channel/server` | `stellar`, `channel`, `close`, `getChannelState`, `watchChannel`, `resolveKeypair`, `Mppx`, `Store`, `Expires`, `ChannelState` (type), `ChannelEvent` (type)                                                                                                                     |
| `@stellar/mpp/env`            | `parseRequired`, `parseOptional`, `parsePort`, `parseStellarPublicKey`, `parseStellarSecretKey`, `parseContractAddress`, `parseHexKey`, `parseCommaSeparatedList`, `parseNumber`                                                                                                 |

### Server options (charge)

```ts
stellar.charge({
  recipient: string,              // Stellar public key (G...) or contract (C...)
  currency: string,               // SEP-41 token contract address
  network?: 'stellar:testnet' | 'stellar:pubnet', // default: 'stellar:testnet'
  decimals?: number,              // default: 7
  rpcUrl?: string,                // custom Soroban RPC URL
  feePayer?: {                     // server-sponsored fee configuration
    envelopeSigner: Keypair | string,   // source account + envelope signer
    feeBumpSigner?: Keypair | string,   // wraps sponsored tx in FeeBumpTransaction
  },
  store?: Store.Store,            // replay protection
  maxFeeBumpStroops?: number,     // max fee bump in stroops (default: 10,000,000)
  pollMaxAttempts?: number,       // max polling attempts (default: 20)
  pollDelayMs?: number,           // delay between poll attempts in ms (default: 1,000)
  pollTimeoutMs?: number,         // overall poll timeout in ms (default: 20,000)
  simulationTimeoutMs?: number,   // simulation timeout in ms (default: 10,000)
  logger?: Logger,                // structured logger (default: no-op)
})
```

### Client options (charge)

```ts
stellar.charge({
  keypair?: Keypair,              // Stellar Keypair (or use secretKey)
  secretKey?: string,             // Stellar secret key (S...)
  mode?: 'push' | 'pull',        // default: 'pull'
  timeout?: number,               // tx timeout in seconds (default: 180)
  decimals?: number,              // default: 7
  rpcUrl?: string,                // custom Soroban RPC URL
  pollMaxAttempts?: number,       // max polling attempts (default: 20)
  pollDelayMs?: number,           // delay between poll attempts in ms (default: 1,000)
  pollTimeoutMs?: number,         // overall poll timeout in ms (default: 20,000)
  simulationTimeoutMs?: number,   // simulation timeout in ms (default: 10,000)
  onProgress?: (event) => void,   // lifecycle callback
})
```

### Server options (channel)

```ts
stellar.channel({
  channel: string,                // on-chain channel contract address (C...)
  commitmentKey: string | Keypair,// ed25519 public key for verifying commitments
  network?: 'stellar:testnet' | 'stellar:pubnet', // default: 'stellar:testnet'
  decimals?: number,              // default: 7
  rpcUrl?: string,                // custom Soroban RPC URL
  sourceAccount?: string,         // funded G... address for simulations
  store?: Store.Store,            // replay protection + cumulative amount tracking
  feePayer?: {                     // fee payer for close/open transactions
    envelopeSigner: Keypair | string,   // source account + envelope signer
    feeBumpSigner?: Keypair | string,   // wraps tx in FeeBumpTransaction
  },
  checkOnChainState?: boolean,    // detect on-chain disputes (default: true)
  onDisputeDetected?: (state) => void, // callback when close_start detected
  maxFeeBumpStroops?: number,     // max fee bump in stroops (default: 10,000,000)
  pollMaxAttempts?: number,       // max polling attempts (default: 20)
  pollDelayMs?: number,           // delay between poll attempts in ms (default: 1,000)
  pollTimeoutMs?: number,         // overall poll timeout in ms (default: 20,000)
  simulationTimeoutMs?: number,   // simulation timeout in ms (default: 10,000)
  logger?: Logger,                // structured logger (default: no-op)
})
```

### Client options (channel)

```ts
stellar.channel({
  commitmentKey?: Keypair,        // ed25519 Keypair for signing commitments
  commitmentSecret?: string,      // ed25519 secret key (S...)
  rpcUrl?: string,                // custom Soroban RPC URL
  simulationTimeoutMs?: number,   // simulation timeout in ms (default: 10,000)
  sourceAccount?: string,         // funded G... address for simulations
  onProgress?: (event) => void,   // lifecycle callback
})
```

### Progress events

The `onProgress` callback receives events at each stage:

**Charge events:**

| Event        | Fields                            | When                                 |
| ------------ | --------------------------------- | ------------------------------------ |
| `challenge`  | `recipient`, `amount`, `currency` | Challenge received                   |
| `signing`    | ---                               | Before signing                       |
| `signed`     | `transaction`                     | After signing                        |
| `paying`     | ---                               | Before broadcast (push mode)         |
| `confirming` | `hash`                            | Polling for confirmation (push mode) |
| `paid`       | `hash`                            | Transaction confirmed (push mode)    |

**Channel events:**

| Event       | Fields                                  | When                      |
| ----------- | --------------------------------------- | ------------------------- |
| `challenge` | `channel`, `amount`, `cumulativeAmount` | Challenge received        |
| `signing`   | ---                                     | Before signing commitment |
| `signed`    | `cumulativeAmount`                      | Commitment signed         |

### Fee sponsorship and fee bumping

The `feePayer` option controls server-sponsored fees per the [Stellar Charge spec](https://paymentauth.org/draft-stellar-charge-00). It groups two keypairs that operate at different stages of the sponsored transaction lifecycle:

#### `feePayer.envelopeSigner` — transaction sponsor

Provides the source account, sequence number, and envelope signature for sponsored transactions. The challenge includes `methodDetails.feePayer: true`, which tells the client:

- **Pull mode is required** — the client must send signed XDR for the server to broadcast (push mode is rejected).
- The client builds the transaction with an **all-zeros placeholder source** and signs only the Soroban authorization entries (not the envelope). The server rebuilds the transaction with its own account and signs the envelope.

Without `feePayer`, both push and pull modes are available and the client builds and signs the full transaction. Per the spec, unsponsored transactions are submitted as-is — the server MUST NOT modify them.

#### `feePayer.feeBumpSigner` — fee bump wrapper (sponsored path only)

When set, the server wraps the **sponsored** transaction in a [`FeeBumpTransaction`](https://developers.stellar.org/docs/learn/glossary#fee-bump-transaction) before broadcasting. This is a post-verification step that applies after the server rebuilds and signs the transaction.

`feeBumpSigner` is nested inside `feePayer` because it only applies to the sponsored path. The spec requires unsponsored transactions to be submitted without modification, so fee bumping an unsponsored transaction would violate the spec.

```ts
import { stellar } from '@stellar/mpp/charge/server'

// Sponsored with fee bumping
stellar.charge({
  recipient: 'G...',
  currency: USDC_SAC_TESTNET,
  feePayer: {
    envelopeSigner: Keypair.fromSecret('S...'), // source account + envelope sig
    feeBumpSigner: Keypair.fromSecret('S...'), // wraps in FeeBumpTransaction
  },
})

// Sponsored without fee bumping
stellar.charge({
  recipient: 'G...',
  currency: USDC_SAC_TESTNET,
  feePayer: {
    envelopeSigner: Keypair.fromSecret('S...'),
  },
})

// Unsponsored (no feePayer — both push and pull available)
stellar.charge({
  recipient: 'G...',
  currency: USDC_SAC_TESTNET,
})
```

### Replay protection

Provide an mppx `Store` to prevent challenge reuse:

```ts
import { Store } from '@stellar/mpp/charge/server'

stellar.charge({
  recipient: 'G...',
  currency: USDC_SAC_TESTNET,
  store: Store.memory(), // or Store.upstash(), Store.cloudflare()
})
```

### Logger

Pass a `logger` to charge or channel servers for structured debug and warning output. The `Logger` interface is compatible with [pino](https://github.com/pinojs/pino) out of the box:

```ts
import pino from 'pino'
import { stellar } from '@stellar/mpp/charge/server'

const logger = pino({ level: 'debug' })

stellar.charge({
  recipient: 'G...',
  currency: USDC_SAC_TESTNET,
  logger, // pino satisfies the Logger interface natively
})
```

### One-way payment channels

Payment channels allow many off-chain micro-payments with minimal on-chain transactions. The [one-way-channel](https://github.com/stellar-experimental/one-way-channel) contract is deployed on Soroban --- no additional npm dependency is needed.

**Prerequisites:**

1. Deploy the channel contract on Stellar (see [one-way-channel repo](https://github.com/stellar-experimental/one-way-channel))
2. The funder opens the channel with an initial token deposit, a `commitment_key` (ed25519 public key), the recipient address, and a refund waiting period
3. Both client (funder) and server (recipient) use the channel contract address

**How it works:**

- The client signs cumulative commitment amounts off-chain using the ed25519 commitment key
- The server verifies signatures by simulating `prepare_commitment` on the channel contract and checking the ed25519 signature
- A `Store` is required on the server to track cumulative amounts across requests
- The server can call `close()` on-chain at any time to settle accumulated payments

**Opening a channel via the SDK:**

The SDK also supports opening a channel through the MPP 402 flow using the `open` action. The client builds the deploy transaction externally (e.g., `stellar contract deploy --send=no`), then passes it as `openTransaction` context alongside an initial commitment. The server verifies the commitment signature and broadcasts the deploy transaction on-chain. See [`examples/channel-open.ts`](examples/channel-open.ts) for a complete example.

**On-chain close (server-side):**

```ts
import { close } from '@stellar/mpp/channel/server'

await close({
  channel: 'CABC...', // channel contract address
  amount: 8000000n, // commitment amount to close with
  signature: commitmentSigBytes, // ed25519 signature from the latest commitment
  feePayer: { envelopeSigner: recipientKeypair },
  network: 'stellar:testnet',
})
```

## Constants

| Constant           | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| `USDC_SAC_MAINNET` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI`   |
| `USDC_SAC_TESTNET` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| `XLM_SAC_MAINNET`  | `CAS3J7GYLGVE45MR3HPSFG352DAANEV5GGMFTO3IZIE4JMCDALQO57Y`  |
| `XLM_SAC_TESTNET`  | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |

## Breaking changes from 0.1.0

- **Package renamed**: `stellar-mpp-sdk` is now `@stellar/mpp`. All import paths change accordingly.
- **Import paths changed**: `stellar-mpp-sdk/client` and `stellar-mpp-sdk/server` are no longer valid. Use `@stellar/mpp/charge/client` and `@stellar/mpp/charge/server` instead.
- **Root export renamed**: `Methods` is now `ChargeMethods`.
- **Store keys changed**: Store key format updated to `stellar:{intent}:{type}:{id}`. Existing stored data is not backwards compatible.
- **`resolveKeypair` moved**: Now exported from the root (`@stellar/mpp`) and from `@stellar/mpp/charge/server`, no longer from `stellar-mpp-sdk/server`.

## Environment variables

Example `.env` files are provided for each demo:

| File                                   | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| `examples/.env.charge-server.example`  | Charge server (recipient key, security settings)    |
| `examples/.env.charge-client.example`  | Charge client (secret key, server URL)              |
| `examples/.env.channel-server.example` | Channel server (contract, commitment key, security) |
| `examples/.env.channel-client.example` | Channel client (commitment secret, server URL)      |

Copy the relevant `.example` file, remove the `.example` suffix, and fill in your values.

## Demo

See [demo/README.md](demo/README.md) for full instructions. Quick start:

```bash
# All-in-one (prompts for keys)
./demo/run.sh

# Or two terminals:
STELLAR_RECIPIENT=G... npx tsx examples/charge-server.ts  # Terminal 1
STELLAR_SECRET=S... npx tsx examples/charge-client.ts      # Terminal 2

# Or npm scripts:
STELLAR_RECIPIENT=G... pnpm demo:charge-server  # Terminal 1
STELLAR_SECRET=S... pnpm demo:charge-client      # Terminal 2
```

Browser UI available at `http://localhost:3000/demo` once the server is running.

### Channel end-to-end (with on-chain settlement)

Run the full channel lifecycle --- deploy, off-chain payments, and on-chain close --- in a single command:

```bash
# Build the one-way-channel WASM first (see https://github.com/stellar-experimental/one-way-channel)
WASM_PATH=path/to/channel.wasm ./demo/run-channel-e2e.sh
```

See [demo/channel-e2e-output.txt](demo/channel-e2e-output.txt) for example output with Stellar Expert links.

## Project structure

Source lives in `sdk/src/` with colocated tests (`*.test.ts`). Each payment mode follows a twin client/server pattern: `Methods.ts` (Zod schema) + `client/` + `server/`. Shared utilities in `shared/` are internal. See `examples/` for runnable servers/clients and `demo/` for shell scripts.

## Development

```bash
corepack enable       # Enable pnpm via corepack
pnpm install          # Install deps (also compiles TypeScript via prepare script)
```

```bash
make help       # Show all available commands
make check      # Run full quality pipeline (format, lint, typecheck, test, build)
make test       # Run tests once
make test-watch # Run tests in watch mode
```

See the [Makefile](Makefile) for all targets.

```bash
pnpm run build        # Compile TypeScript
pnpm run check:types  # Type-check without emitting
pnpm run lint         # Run ESLint
pnpm run format:check # Check formatting
pnpm test             # Run tests (vitest)
```

## Resources

Background on the protocol this SDK implements and the framework it builds on:

- [Machine Payments Protocol (MPP)](https://mpp.dev) — the HTTP 402-based protocol for machine-to-machine payments
- [MPP specifications](https://github.com/tempoxyz/mpp-specs) — the protocol spec repository (intents, methods, and the HTTP Payment Authentication scheme)
  - [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00) ([source](https://github.com/tempoxyz/mpp-specs/blob/main/specs/methods/stellar/draft-stellar-charge-00.md)) — the `stellar` method / `charge` intent this SDK implements
- [mppx](https://github.com/wevm/mppx) — the TypeScript MPP framework this SDK plugs into (`Method.from` / `.toClient` / `.toServer`); peer dependency
- [one-way-channel](https://github.com/stellar-experimental/one-way-channel) — the Soroban contract backing the channel payment mode

## License

MIT
