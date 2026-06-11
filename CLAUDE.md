# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stellar MPP SDK — a TypeScript SDK implementing Stellar blockchain payment methods for the Machine Payments Protocol (MPP). Provides two payment modes:

- **Charge**: One-time on-chain SEP-41 token transfers with pull/push credential modes
- **Channel**: Off-chain payment commitments via one-way payment channel contracts (batch settlement on close)

Built on the `mppx` framework. Peer dependencies: `@stellar/stellar-sdk` (^15.1.0) and `mppx` (^0.6.29).

## Terminology

This project works with **SEP-41 token transfers** — the Stellar standard interface for fungible tokens. SAC (Stellar Asset Contract) is one implementation of SEP-41, but the SDK supports any SEP-41-compliant token contract. Use "SEP-41 token transfer" or "token transfer" in code, comments, and documentation — not "SAC transfer."

## Commands

```bash
pnpm install            # Install deps (also runs `tsc` via prepare script)
pnpm run build          # Compile TypeScript → dist/
pnpm run check:types    # Type-check only (tsc --noEmit)
pnpm test               # Run vitest (watch mode)
pnpm test -- --run      # Run tests once without watch
pnpm test -- sdk/src/charge/client/Charge.test.ts   # Run a single test file
make check              # Run full quality pipeline (mirrors CI)
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
```

## Completion Checklist

Before committing or telling the user a task is complete:

1. Run `make check` — mirrors CI: formatting, lint, type-check, tests, build. Fix any failures before proceeding.
2. If formatting fails, run `npx prettier --write .` — applies to **all** changed files including `.md`.
3. Call the `/e2e-check` skill to run end-to-end checks.

## Architecture

Each payment mode mirrors a client and server sharing a common Zod method schema:

```
Methods.ts (Zod schema) → client/ (create credentials) + server/ (verify credentials)
```

### Charge Flows

Charge has 6 combinations from 3 axes: **push vs pull**, **sponsored vs unsponsored**, and **FeeBump vs no FeeBump**.

| Flow | Mode | Sponsorship | FeeBump | Who broadcasts | Who pays fee             |
| ---- | ---- | ----------- | ------- | -------------- | ------------------------ |
| 1    | push | unsponsored | no      | client         | client                   |
| 2    | push | unsponsored | yes     | client         | fee bump key             |
| 3    | pull | unsponsored | no      | server         | client (via tx)          |
| 4    | pull | unsponsored | yes     | server         | fee bump key             |
| 5    | pull | sponsored   | no      | server         | server (envelope signer) |
| 6    | pull | sponsored   | yes     | server         | fee bump key             |

- **Push** (`type: 'signedHash'`): Client broadcasts the tx on-chain, sends a hash credential containing the tx hash and a payer-bound signature to the server. Server verifies the signature and polls the chain to verify the tx. Legacy unsigned `type: 'hash'` is deprecated and receive-only.
- **Pull** (`type: 'transaction'`): Client sends signed tx XDR to the server. Server verifies and broadcasts.
- **Sponsored** (`feePayer` configured on server): Server rebuilds the tx with its own source account, signs the envelope, and pays the network fee. Client tx uses `ALL_ZEROS` as source.
- **FeeBump**: The tx is wrapped in a `FeeBumpTransaction` so a separate key pays the network fee.

### Key Patterns

- **mppx integration**: Methods defined via `Method.from()`, adapted with `.toClient()` / `.toServer()`.
- **Replay protection**: Servers claim challenges and tx hashes via atomic `store.update()` compare-and-set (a `Store.AtomicStore` is required and validated at construction), so each is consumed exactly once without a get-then-put race.
- **Contract simulation**: Uses Soroban RPC `simulateTransaction` for read-only verification — SEP-41 transfer validation, `prepare_commitment` for commitment bytes, and channel state queries.
- **Configurable defaults**: Server/client functions accept optional parameters with defaults from `shared/defaults.ts`.
- **Store key naming**: `stellar:{intent}:{type}:{id}` (e.g., `stellar:charge:challenge:abc123`).
- **Env parsing**: Published as `@stellar/mpp/env`. Per-example `Env` classes in `examples/config/` compose primitives from `sdk/src/env.ts`.

### Test Setup

- **Vitest** with colocated test files (`*.test.ts` next to `*.ts`)
- Tests mock `@stellar/stellar-sdk` and `mppx` internals
- **ESLint 9** flat config, **Prettier** for formatting
- **GitHub Actions** CI: format-check → lint → typecheck → test → build
- **Makefile** for dev workflow (`make check` mirrors CI)
