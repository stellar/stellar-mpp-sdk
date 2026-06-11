#!/usr/bin/env bash
#
# Stellar MPP Channel — End-to-End Demo with On-Chain Settlement
#
# Full lifecycle: deploy → off-chain payments → on-chain close
# All transactions reported for verification on Stellar Expert.
#
# Prerequisites:
#   - stellar CLI (https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli)
#   - Node.js 20+
#   - one-way-channel WASM (build from https://github.com/stellar-experimental/one-way-channel)
#
# Usage:
#   WASM_PATH=path/to/channel.wasm ./demo/run-channel-e2e.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

cat << 'BANNER'

═══════════════════════════════════════════════════════════
  Stellar MPP Channel — End-to-End Demo
  Full lifecycle: deploy → off-chain payments → on-chain close
═══════════════════════════════════════════════════════════

BANNER

# ── Check prerequisites ──────────────────────────────────────────────────────

WASM_PATH="${WASM_PATH:-}"

if ! command -v stellar &>/dev/null; then
  echo "❌ stellar CLI not found."
  echo "   Install: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli"
  exit 1
fi

if ! command -v npx &>/dev/null; then
  echo "❌ npx not found. Install Node.js 20+."
  exit 1
fi

if [ -z "$WASM_PATH" ]; then
  echo "❌ Set WASM_PATH to the one-way-channel contract WASM file."
  echo ""
  echo "   Build it from the one-way-channel repo:"
  echo "     git clone https://github.com/stellar-experimental/one-way-channel"
  echo "     cd one-way-channel"
  echo "     stellar contract build"
  echo "     # WASM is at: target/wasm32v1-none/release/channel.wasm"
  echo ""
  echo "   Then run:"
  echo "     WASM_PATH=path/to/channel.wasm ./demo/run-channel-e2e.sh"
  exit 1
fi

if [ ! -f "$WASM_PATH" ]; then
  echo "❌ WASM file not found: $WASM_PATH"
  exit 1
fi

# ── Unique names for this demo run ───────────────────────────────────────────

DEMO_ID="mpp-e2e-$(date +%s)"
FUNDER="${DEMO_ID}-funder"
RECIPIENT="${DEMO_ID}-recipient"
DEPOSIT=10000000  # 1 XLM initial deposit (in stroops)
PORT=${PORT:-3002}
# Close path to exercise on-chain settlement:
#   mpp      — drive the close through the MPP 402 credential flow (server settles)
#   operator — call the standalone operator close() admin function directly
CLOSE_MODE="${CLOSE_MODE:-mpp}"
if [ "$CLOSE_MODE" = "operator" ]; then
  CLOSE_STEP_DESC="Operator called close() directly to settle on-chain"
  CLOSE_TX_DESC="broadcast by the operator close() admin function"
else
  CLOSE_STEP_DESC="Client sent an MPP action:'close' credential; the server validated it, set the settling marker, and broadcast the close"
  CLOSE_TX_DESC="broadcast by the server via the MPP credential flow"
fi
VOUCHER_CUMULATIVE=2000000  # 0.2 XLM — cumulative after 2 off-chain payments of 0.1 XLM
# Final settlement commitment. The server enforces a strictly-increasing cumulative,
# so the MPP close must settle ABOVE the last off-chain voucher cumulative.
CLOSE_AMOUNT=3000000  # 0.3 XLM — final closing commitment settled on-chain

echo "Demo ID: $DEMO_ID"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 1: Create funded testnet accounts
# ══════════════════════════════════════════════════════════════════════════════

echo "═══ Step 1: Creating funded testnet accounts ═══"
echo ""

echo "  Creating funder account..."
stellar keys generate "$FUNDER" --fund --network testnet --overwrite 2>/dev/null
FUNDER_ADDR=$(stellar keys address "$FUNDER")
echo "  ✔ Funder:    $FUNDER_ADDR"

echo "  Creating recipient account..."
stellar keys generate "$RECIPIENT" --fund --network testnet --overwrite 2>/dev/null
RECIPIENT_ADDR=$(stellar keys address "$RECIPIENT")
echo "  ✔ Recipient: $RECIPIENT_ADDR"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 2: Generate ed25519 commitment keypair
# ══════════════════════════════════════════════════════════════════════════════

echo "═══ Step 2: Generating ed25519 commitment keypair ═══"
echo ""

# Generate a random ed25519 keypair using Node.js + stellar-sdk
read -r COMMITMENT_SKEY COMMITMENT_PKEY < <(npx tsx -e "
import crypto from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'
const seed = crypto.randomBytes(32)
const kp = Keypair.fromRawEd25519Seed(seed)
console.log(seed.toString('hex') + ' ' + Buffer.from(kp.rawPublicKey()).toString('hex'))
" 2>/dev/null)

echo "  ✔ Public:  $COMMITMENT_PKEY"
echo "  ✔ Secret:  ${COMMITMENT_SKEY:0:8}...${COMMITMENT_SKEY: -8} (hidden)"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 3: Upload WASM and deploy channel contract
# ══════════════════════════════════════════════════════════════════════════════

echo "═══ Step 3: Deploying channel contract ═══"
echo ""

echo "  Uploading WASM..."
WASM_HASH=$(stellar contract upload \
  --wasm "$WASM_PATH" \
  --source "$FUNDER" \
  --network testnet)
echo "  ✔ WASM hash: $WASM_HASH"

echo "  Deploying channel (deposit: $DEPOSIT stroops = $(echo "scale=1; $DEPOSIT / 10000000" | bc) XLM)..."
CONTRACT=$(stellar contract deploy \
  --wasm-hash "$WASM_HASH" \
  --source "$FUNDER" \
  --network testnet \
  -- \
  --token native \
  --from "$FUNDER" \
  --commitment_key "$COMMITMENT_PKEY" \
  --to "$RECIPIENT" \
  --amount "$DEPOSIT" \
  --refund_waiting_period 100)
echo "  ✔ Contract:  $CONTRACT"

echo ""
echo "  Channel balance after deploy:"
BALANCE_BEFORE=$(stellar contract invoke \
  --id "$CONTRACT" \
  --source "$FUNDER" \
  --network testnet \
  --send=no \
  -- balance)
echo "    $BALANCE_BEFORE stroops"

echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 4: Off-chain MPP payments (no on-chain transactions)
# ══════════════════════════════════════════════════════════════════════════════

echo "═══ Step 4: Off-chain MPP payments (2 requests × 0.1 XLM) ═══"
echo ""

# Kill any existing process on the port
if command -v lsof &>/dev/null && lsof -ti:$PORT &>/dev/null; then
  echo "  ⚠ Port $PORT in use — freeing it..."
  lsof -ti:$PORT | xargs kill -9 2>/dev/null
  sleep 1
fi

# The recipient account sources and signs the on-chain close envelope (feePayer).
RECIPIENT_SECRET=$(stellar keys show "$RECIPIENT")

echo "  Starting channel server on port $PORT (with feePayer for on-chain settlement)..."
CHANNEL_CONTRACT="$CONTRACT" \
COMMITMENT_PUBKEY="$COMMITMENT_PKEY" \
CHANNEL_ENVELOPE_SIGNER_SECRET="$RECIPIENT_SECRET" \
PORT=$PORT \
npx tsx examples/channel-server.ts &
SERVER_PID=$!
trap "kill $SERVER_PID 2>/dev/null" EXIT

# Wait for server to be ready
for i in $(seq 1 15); do
  if curl -s "http://localhost:$PORT" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo ""
echo "  Running channel client (2 off-chain payments)..."
echo ""

CHANNEL_CONTRACT="$CONTRACT" \
COMMITMENT_SECRET="$COMMITMENT_SKEY" \
SERVER_URL="http://localhost:$PORT" \
npx tsx examples/channel-client.ts

echo ""
echo "  ✔ Off-chain phase complete (cumulative: $VOUCHER_CUMULATIVE stroops)."
if [ "$CLOSE_MODE" = "operator" ]; then
  echo "    Settling on-chain via the standalone operator close() function."
else
  echo "    Server kept running for on-chain settlement via the MPP close credential."
fi
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 5: On-chain settlement — close the channel
# ══════════════════════════════════════════════════════════════════════════════

if [ "$CLOSE_MODE" = "operator" ]; then
  echo "═══ Step 5: On-chain settlement — closing channel (operator close()) ═══"
  echo ""

  # Call the standalone operator close() admin function directly (no MPP credential).
  # This is the server-side reconciliation path: it signs the commitment and
  # broadcasts the close itself, bypassing the 402 flow and the settling marker.
  CHANNEL_CONTRACT="$CONTRACT" \
  COMMITMENT_SECRET="$COMMITMENT_SKEY" \
  CLOSE_SECRET="$RECIPIENT_SECRET" \
  AMOUNT="$CLOSE_AMOUNT" \
  npx tsx examples/channel-close.ts
else
  echo "═══ Step 5: On-chain settlement — closing channel (via MPP credential) ═══"
  echo ""

  # Drive the close through the MPP 402 flow: the client sends an action:'close'
  # credential and the server (with its configured feePayer) validates it, sets the
  # per-channel settling marker, and broadcasts the close on-chain. This exercises
  # doVerifyClose and the settling-window protection — unlike the standalone close().
  CHANNEL_CONTRACT="$CONTRACT" \
  COMMITMENT_SECRET="$COMMITMENT_SKEY" \
  CLOSE_AMOUNT="$CLOSE_AMOUNT" \
  SERVER_URL="http://localhost:$PORT" \
  npx tsx examples/channel-close-mpp.ts
fi

echo ""

# Stop server now that settlement is complete
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
trap - EXIT
echo "  ✔ Server stopped. Settlement complete."
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 6: Verify final state
# ══════════════════════════════════════════════════════════════════════════════

echo "═══ Step 6: Final channel state ═══"
echo ""

echo "  Channel balance after close:"
BALANCE_AFTER=$(stellar contract invoke \
  --id "$CONTRACT" \
  --source "$FUNDER" \
  --network testnet \
  --send=no \
  -- balance)
echo "    $BALANCE_AFTER stroops"
echo ""
echo "  (close transferred $CLOSE_AMOUNT to recipient, auto-refunded remainder to funder)"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════

cat << SUMMARY

═══════════════════════════════════════════════════════════════════
  Demo Complete — Verify on Stellar Expert (testnet)
═══════════════════════════════════════════════════════════════════

  Accounts:
    Funder:    https://stellar.expert/explorer/testnet/account/$FUNDER_ADDR
    Recipient: https://stellar.expert/explorer/testnet/account/$RECIPIENT_ADDR

  Contract:
    Channel:   https://stellar.expert/explorer/testnet/contract/$CONTRACT

  What happened:
    1. Funder deployed channel contract with $DEPOSIT stroops deposit
    2. Client made 2 off-chain payments (0.1 XLM each) — no on-chain tx
    3. $CLOSE_STEP_DESC ($CLOSE_AMOUNT stroops)
       → $CLOSE_AMOUNT transferred to recipient
       → remainder auto-refunded to funder

  Look for these transactions on the funder's account:
    • Contract upload (uploadWasm)
    • Contract deploy (__constructor) with $DEPOSIT stroops transfer
  And on the recipient's account:
    • Channel close (close) — $CLOSE_TX_DESC

═══════════════════════════════════════════════════════════════════
SUMMARY
