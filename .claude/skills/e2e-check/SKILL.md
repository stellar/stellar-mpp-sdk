---
name: e2e-check
description: Use when verifying the full solution works end-to-end — after refactoring, before PRs, or after dependency upgrades. Runs quality pipeline, validates example scripts, and executes live Stellar testnet demos for both charge and channel payment modes.
---

# E2E Check

Full end-to-end verification: quality pipeline, example script validation, and live Stellar testnet demos.

**Prerequisites:** `.env` file at project root with testnet keys (see `examples/.env.*.example`), funded Stellar testnet accounts, `pnpm` installed.

Run all checks in order. Stop on first failure and report.

## Check 1: Full Quality Pipeline

```bash
make check
```

Runs: install -> format-check -> lint -> typecheck -> test -> build.

This includes the **mocked integration tier** (`sdk/src/**/integration/mocked/**`) — the
deterministic full-`verify()`-dispatch tests, including the settling-window TOCTOU end-to-end
regression and the cross-process replay tests. They are CI gates, not an opt-in suite.

**Pass:** 0 lint errors (warnings OK), all tests pass, build succeeds.

## Check 1b: Live Integration Suite (testnet)

The `integration/live/**` tier holds vitest tests that run against Stellar testnet (network
access + funded accounts required). It is excluded from `make check` and run on demand:

```bash
make test-integration   # = pnpm run test:integration
```

Currently this is the charge e2e suite (`charge/integration/live/accepts/e2e.test.ts`) — all
six charge flows submitted as real transactions. Complements the example-script flows in Check 2b.

**Pass:** All live flows pass.

> **Integration test layout** (`sdk/src/<module>/integration/`):
>
> | Tier | Path | Runner | Asserts |
> | ---- | ---- | ------ | ------- |
> | mocked | `integration/mocked/{accepts,rejects}/` | `make check` | deterministic dispatch — accepts = valid flow succeeds, rejects = malicious input refused |
> | live | `integration/live/{accepts,rejects}/` | `make test-integration` | real testnet behavior |

## Check 2: Example Script Validation

Verify all example scripts start correctly (imports resolve, env parsing works):

```bash
for f in examples/charge-server.ts examples/charge-client.ts examples/charge-client-fee-bump.ts examples/channel-server.ts examples/channel-client.ts examples/channel-close.ts; do
  echo "--- $f ---"
  timeout 3 npx tsx "$f" 2>&1 | head -3
  echo ""
done
```

**Pass criteria per script:**

| Script                       | Expected                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| `examples/charge-server.ts`  | Starts Express on port 3000 (pino JSON log)                     |
| `examples/charge-client.ts`          | Loads keypair, starts client                                                   |
| `examples/charge-client-fee-bump.ts` | Loads keypair+fee-bump-key, prints account keys, ECONNREFUSED |
| `examples/channel-server.ts` | Starts Express on port 3001 (pino JSON log)                     |
| `examples/channel-client.ts` | Loads commitment key, starts client                             |
| `examples/channel-close.ts`  | Env validation error: `CLOSE_SECRET is required` (expected)     |

**Fail:** Any import error, syntax error, or module-not-found error.

## Check 2b: Charge Flow Variations

Six flows are available by combining client and server env vars. Each requires a running
charge server (Terminal 1) and charge client (Terminal 2).

> **⚠️ Env leak — do NOT `source .env` in the shell that launches the UNSPONSORED server.**
> If `ENVELOPE_SIGNER_SECRET` (or `FEE_BUMP_SIGNER_SECRET`) reaches the server process, it
> silently switches to sponsored mode and advertises `"feePayer":true` in the challenge.
> Flows 1–4 then fail even though the code is correct. Failure signature:
>
> - Flow 1 client errors: `Push mode is not supported for server-sponsored transactions`
> - Flow 2 gets a 402; server log: `Push mode (type="hash") is not allowed with feePayer=true`
> - The challenge's base64 `request` contains `"feePayer":true`
>
> Safe pattern — pull individual values out of `.env` instead of sourcing it, and strip the
> signer vars from the server's environment as a belt-and-braces guard:
>
> ```bash
> RECIP=$(grep '^STELLAR_RECIPIENT=' .env | cut -d= -f2- | tr -d '"')
> env -u ENVELOPE_SIGNER_SECRET -u FEE_BUMP_SIGNER_SECRET \
>   PORT=3099 STELLAR_RECIPIENT="$RECIP" npx tsx examples/charge-server.ts
> ```
>
> Before running flows 1–4, confirm the challenge does NOT contain `"feePayer":true`.
> Only flows 5–6 set the signer secrets — deliberately, in their own server processes.

### Server configurations

```bash
# Unsponsored (flows 1-4): no feePayer env vars needed — see env-leak warning above
env -u ENVELOPE_SIGNER_SECRET -u FEE_BUMP_SIGNER_SECRET \
  PORT=3099 STELLAR_RECIPIENT=G... npx tsx examples/charge-server.ts

# Sponsored, no fee bump (flow 5): set ENVELOPE_SIGNER_SECRET
PORT=3099 STELLAR_RECIPIENT=G... ENVELOPE_SIGNER_SECRET=S... \
  npx tsx examples/charge-server.ts

# Sponsored + FeeBump (flow 6): set both signer secrets
PORT=3099 STELLAR_RECIPIENT=G... ENVELOPE_SIGNER_SECRET=S... FEE_BUMP_SIGNER_SECRET=S... \
  npx tsx examples/charge-server.ts
```

### Client invocations (Terminal 2, replace S... with real key)

```bash
# Flow 1: push (no FeeBump)
STELLAR_SECRET=S... SERVER_URL=http://localhost:3099 CHARGE_CLIENT_MODE=push \
  npx tsx examples/charge-client.ts

# Flow 2: push + FeeBump
STELLAR_SECRET=S... FEE_BUMP_SECRET=S... SERVER_URL=http://localhost:3099 CHARGE_CLIENT_MODE=push \
  npx tsx examples/charge-client-fee-bump.ts

# Flow 3: pull non-sponsored (no FeeBump)  [default CHARGE_CLIENT_MODE]
STELLAR_SECRET=S... SERVER_URL=http://localhost:3099 \
  npx tsx examples/charge-client.ts

# Flow 4: pull non-sponsored + FeeBump
STELLAR_SECRET=S... FEE_BUMP_SECRET=S... SERVER_URL=http://localhost:3099 \
  npx tsx examples/charge-client-fee-bump.ts

# Flow 5: pull sponsored (no FeeBump) — server must have ENVELOPE_SIGNER_SECRET set
STELLAR_SECRET=S... SERVER_URL=http://localhost:3099 \
  npx tsx examples/charge-client.ts

# Flow 6: pull sponsored + FeeBump
# NOTE: client invocation is identical to Flow 5 — the difference is ONLY the server config.
# The server's feeBumpSigner wraps the rebuilt tx in FeeBump; no client-side change needed.
STELLAR_SECRET=S... SERVER_URL=http://localhost:3099 \
  npx tsx examples/charge-client.ts
```

**Pass:** Each client prints `--- Response (200) ---` with paid content JSON.

## Check 3: Charge E2E Demo

```bash
source .env
STELLAR_RECIPIENT="$STELLAR_RECIPIENT" STELLAR_SECRET="$STELLAR_SECRET" timeout 15 ./demo/run.sh
```

**Expected flow:**

1. Server starts on port 3000 with pino JSON logging
2. Client receives 402 Payment Required challenge
3. Client signs SAC transfer transaction
4. Server verifies and broadcasts on Stellar testnet
5. **200 OK** with "Payment verified" message

**Pass:** Client prints `--- Response (200) ---` with paid content JSON.

## Check 4: Channel E2E Demo

```bash
source .env
CHANNEL_CONTRACT="$CHANNEL_CONTRACT" COMMITMENT_PUBKEY="$COMMITMENT_PUBKEY" COMMITMENT_SECRET="$COMMITMENT_SECRET" timeout 15 ./demo/run-channel.sh
```

**Expected flow:**

1. Channel server starts on port 3001 with pino JSON logging
2. Client makes 2 requests, signing cumulative commitments off-chain
3. Request 1: cumulative 1,000,000 stroops -> **200 OK**
4. Request 2: cumulative 2,000,000 stroops -> **200 OK**
5. "No on-chain transaction was needed for this payment!"

**Pass:** Both requests return 200. Cumulative amount grows between requests.

## Check 5: Channel E2E with On-Chain Settlement

Requires the compiled one-way-channel WASM from https://github.com/stellar-experimental/one-way-channel.

```bash
WASM_PATH=/Users/marcelosantos/Workspace/one-way-channel/target/wasm32v1-none/release/channel.wasm \
  timeout 60 ./demo/run-channel-e2e.sh
```

Full lifecycle: deploy contract -> 2 off-chain payments -> on-chain close -> balance verified at 0.

**Expected flow:**

1. Deploys one-way-channel contract on Stellar testnet
2. Funder opens channel with initial deposit
3. 2 off-chain payment commitments via MPP 402 flow
4. Recipient closes channel on-chain with latest commitment
5. Final balance verified at 0 (all funds claimed)

**Pass:** Script completes with `Channel balance after close: 0` and exit code 0.

## Check 5b: Channel E2E with On-Chain Settlement via operator `close()`

Same lifecycle as Check 5, but settles through the standalone operator `close()` admin
function (`examples/channel-close.ts`) instead of the MPP credential flow. This keeps the
operator-close path covered live — the MPP-mode demo (Check 5) does not exercise it.

```bash
WASM_PATH=/Users/marcelosantos/Workspace/one-way-channel/target/wasm32v1-none/release/channel.wasm \
  CLOSE_MODE=operator timeout 120 ./demo/run-channel-e2e.sh
```

**Pass:** Script completes with `Channel balance after close: 0` and Step 5 reports
`closing channel (operator close())`.

## Check 6: CHANGELOG Entry

Every PR must add a line to `CHANGELOG.md` under the `## [Unreleased]` heading. Each entry must link to its PR using the format:

```
- Description of the change [#PR_NUMBER](https://github.com/stellar/stellar-mpp-sdk/pull/PR_NUMBER)
```

**Pass:** The diff includes a CHANGELOG.md addition with a PR link in the correct format.

**Fail:** No CHANGELOG entry, or entry missing the `[#N](url)` PR link.

## Reporting

After running all checks, report:

| #    | Check                                              | Status    | Notes                                                          |
| ---- | -------------------------------------------------- | --------- | -------------------------------------------------------------- |
| 1    | `make check` (full pipeline + mocked integration)  | PASS/FAIL | test count, any errors                                         |
| 1b   | Live integration suite (`make test-integration`)   | PASS/FAIL | testnet charge flows                                           |
| 2a   | Example scripts (6 scripts)                        | PASS/FAIL | which scripts failed                                           |
| 2b-1 | Charge: push, no FeeBump                           | PASS/FAIL | 200 or error                                                   |
| 2b-2 | Charge: push + FeeBump                             | PASS/FAIL | 200 or error                                                   |
| 2b-3 | Charge: pull unsponsored                           | PASS/FAIL | 200 or error                                                   |
| 2b-4 | Charge: pull unsponsored + FeeBump                 | PASS/FAIL | 200 or error                                                   |
| 2b-5 | Charge: pull sponsored                             | PASS/FAIL | 200 or error                                                   |
| 2b-6 | Charge: pull sponsored + FeeBump                   | PASS/FAIL | 200 or error                                                   |
| 3    | Charge E2E (`demo/run.sh`)                         | PASS/FAIL | final HTTP status                                              |
| 4    | Channel E2E (`demo/run-channel.sh`)                | PASS/FAIL | request count, cumulative amounts                              |
| 5    | Channel E2E settlement (`demo/run-channel-e2e.sh`) | PASS/FAIL | balance after close. ATTENTION: this is explained in `Check 5` |
| 5b   | Channel E2E settlement via operator `close()`      | PASS/FAIL | balance after close (CLOSE_MODE=operator)                      |
| 6    | CHANGELOG entry                                    | PASS/FAIL | PR link present                                                |
