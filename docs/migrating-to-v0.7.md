# Migrating to v0.7

v0.7 ships a security fix for push-mode charge payments, plus two smaller
breaking changes. This guide covers what changed and the minimum edits to
upgrade from v0.6.x. For full context, see the SDK PR:
<https://github.com/stellar/stellar-mpp-sdk/pull/47>.

## Are you affected?

You are affected if you built a **push-mode charge flow** — the client pays
on-chain and sends the server a transaction hash to claim the resource.
**Pull-mode and channel flows are not affected by the credential change.** All
servers are affected by the store requirement below.

## What changed and why

In push mode the server previously identified the payer from an unsigned field
the client supplied. Because confirmed payments and their payer keys are public
on-chain, a party other than the payer could present someone else's payment to
claim a gated resource. v0.7 closes this by binding the credential to a
signature from the paying account, so only the payer can redeem their payment.

## Push credential format (breaking)

The push credential `type` changes from `hash` to `signedHash` and gains a
`sourceSignature`:

```ts
// Before (v0.6)
{ type: 'hash', hash: '...' }

// After (v0.7)
{ type: 'signedHash', hash: '...', sourceSignature: '...' }
```

`sourceSignature` is a hex signature over the string `"{challenge.id}:{hash}"`
(the challenge id and the **lowercase** tx hash joined by a colon), made with
the private key of the transfer's on-chain `from` account. If you use the SDK
client, upgrading it is enough — it produces `signedHash` from the paying
keypair automatically.

## Legacy unsigned push (`allowUnsignedPush`)

By default, v0.7 **rejects** the legacy `{ type: 'hash' }` credential and tells
the client to send `signedHash`. If you need a transition window while clients
upgrade, opt back in at construction:

```ts
charge({
  // ...
  allowUnsignedPush: true, // temporarily accept legacy { type: 'hash' }
})
```

When enabled, the server still accepts unsigned push but logs every acceptance
so you can see which clients still need to migrate. Remove it once they send
`signedHash`. (Sponsored servers advertise pull mode only and never accept push
credentials.)

## AtomicStore requirement (breaking)

Replay protection now relies on an atomic compare-and-set via `update()`. The
charge and channel servers **throw at construction** if the store has no
`update()` method:

```ts
import { Store } from 'mppx'

const store = Store.memory() // correct single-process reference
// multi-process deployments need a shared backend whose update() is a genuine
// atomic CAS, e.g. Store.upstash() or Store.cloudflare()
```

See the [Store requirement](../README.md#one-way-payment-channels) notes for why
a get-then-put or eventually-consistent backend is not sufficient.

## Channel `open` removed (breaking)

The channel `open` MPP action and `examples/channel-open.ts` are gone — channels
are created by the contract constructor at deploy time. Deploy the channel
out-of-band (e.g. with the `stellar` CLI); off-chain vouchers and on-chain close
are unchanged. See the channel section of the
[README](../README.md#one-way-payment-channels).

## Migration checklist

1. Update the SDK to v0.7.
2. Update the client to send `signedHash` credentials (built-in clients do this
   automatically).
3. Ensure the server store implements `update()` — the server throws otherwise.
4. Remove any use of the channel `open` action.
5. Optional: set `allowUnsignedPush: true` only for a temporary window while
   clients migrate, then remove it.

## If a payment was lost

If a user paid on-chain but was denied the resource under the old flow, the
payment still settled — the funds reached the recipient. Resolve it out of band
with the server operator.
