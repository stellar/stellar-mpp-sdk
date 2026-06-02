# Experiment: class-XDR `@stellar/stellar-sdk` (PR stellar/js-stellar-sdk#1422)

Branch: `experimental-new-sdk`. Swaps the published `@stellar/stellar-sdk@15.0.1`
for the in-development **class-XDR** rewrite (`class-xdr` branch, commit `c7eb18e`)
and migrates the whole MPP SDK to its new API.

## 1. The replacement work

- **Install strategy.** `@stellar/stellar-sdk` is pinned via a pnpm `overrides`
  entry to the upstream class-XDR commit (`github:stellar/js-stellar-sdk#c7eb18e`)
  and **built from git** — no vendored blob. Two snags make that branch awkward to
  install directly, both handled by the `make install` target (the project's standard
  entrypoint, which `make check`/CI use): (1) its `prepare` runs `setup`
  (`git config blame.ignoreRevsFile …`) which dies "not in a git directory" inside
  pnpm's build sandbox — so `make install` points `GIT_DIR` at a throwaway repo so
  that write succeeds; (2) the inlined-js-xdr ESM marker (see fix #3 below) is applied
  post-install by `scripts/patch-classxdr-esm.mjs`. (A bare `pnpm install` builds the
  SDK but skips these two steps — use `make install` on this branch.)
- **Code migration.** ~192 XDR call sites across **~34 files** (8 source, ~13 test,
  examples). Driven largely by **parallel sub-agents** (one per file/group) with a
  shared cheat-sheet and a "typecheck/tests to zero" requirement; each agent's diff
  was reviewed. Mechanical patterns:
  - union access `.switch()/.value()/.arm()` → `.type` string discriminant + arm
    property, with type-safe narrowing (no casts);
  - enum singletons: drop the call parens (`ScValType.scvU32()` → `…scvU32`);
  - `toXDR/fromXDR` → `toXdr/fromXdr`;
  - wide ints: `Int128Parts`/`Uint128Parts` take/expose `bigint` `.hi`/`.lo`;
    `scvU64/scvI64` take `bigint`; `Uint64`/`Int64` are native bigint;
  - byte wrappers: `new xdr.Hash(buf)`, `new xdr.ContractId(buf)`, `new xdr.ScBytes(buf)`;
  - `ScBytes.value` is a `Uint8Array` (was a Buffer).
- **Three non-obvious fixes beyond mechanical renames:**
  1. **`tsconfig` needs `"types": ["node"]`.** The class-XDR build uses `Uint8Array`
     instead of `Buffer` and no longer transitively pulls `@types/node`, so
     `process`/`Buffer` globals stopped resolving.
  2. **`authorizeInvocation` signature changed** to a single params object
     (`{ signer, validUntilLedgerSeq, invocation, networkPassphrase }`) — the draft
     bundles an `auth.ts` refactor, so this is not purely an XDR change.
  3. **tsx/esbuild couldn't load the SDK.** The rollup build _inlines_ `@stellar/js-xdr`'s
     ESM source under `lib/esm/node_modules/.pnpm/…` (a documented stopgap until js-xdr
     ships ESM). Plain Node resolves these via the SDK's root `type:module`, but
     tsx/esbuild's nearest-`package.json` walk stops at the js-xdr boundary and treats
     them as CJS, breaking named imports. Fixed by `scripts/patch-classxdr-esm.mjs`
     (run from `make install`), which drops a `{"type":"module"}` marker at each
     inlined js-xdr package root.

## 2. Verification — everything passes

- `make check`: format ✓, lint ✓, **type-check 0 errors** ✓, **391/391 tests** ✓,
  build ✓, `pnpm audit` (high+) clean ✓.
- `/e2e-check` against **live Stellar testnet**:
  - 7/7 example scripts start correctly;
  - Charge E2E → **200 OK** (sign + broadcast SAC transfer);
  - Channel E2E → 2× **200 OK** off-chain (cumulative 1M→2M stroops);
  - Channel **on-chain settlement** → deploy → 2 off-chain payments → close →
    **balance 0** (all funds claimed).

## 3. Impressions

- **DX is the headline, and it's a real improvement.** Union access via `.type` +
  arm properties with TypeScript narrowing removes a whole class of `as`-casts; native
  `bigint` ints and property-access enums read far cleaner. The migration was almost
  entirely mechanical once the patterns were clear.
- **It's a draft, and it shows.** The js-xdr inlining breaks tsx out of the box; the
  build can't `pnpm install` from git; `version` isn't exported the same way. All
  surmountable, none production-ready.
- **Test coverage gap exposed:** unit tests mock `@stellar/stellar-sdk`, so the real
  SDK ESM was never actually loaded until the example/demo scripts ran — that's where
  the packaging and `.bytes()` issues surfaced, not in `make check`.

## 4. Gains / costs (isolated installs; old `15.0.1` vs new class-XDR)

| Metric                                       | Old 15.0.1              | New class-XDR           | Δ              |
| -------------------------------------------- | ----------------------- | ----------------------- | -------------- |
| `npm install` (isolated)                     | 2.5 s                   | 11.6 s                  | ~4.6× slower   |
| `@stellar/stellar-sdk` on disk               | 14 MB                   | 58 MB                   | ~4.1× larger   |
| SDK + transitive deps                        | 30 MB                   | 66 MB                   | ~2.2× larger   |
| `@stellar/js-xdr`                            | 832 KB (separate dep)   | bundled in              | —              |
| Import time                                  | ~77 ms                  | ~117 ms                 | +52%           |
| Heap after import                            | 10.6 MB                 | 19.3 MB                 | +82%           |
| XDR envelope round-trip (decode+read+encode) | ~342k ops/s (2.9 µs/op) | ~69k ops/s (14.5 µs/op) | **~5× slower** |
| Peak RSS (50k-iter loop)                     | ~108 MB                 | ~111 MB                 | ≈ same         |
| MPP `dist/` bundle                           | 684 KB                  | 684 KB                  | unchanged      |

- **Bundle size (our SDK):** unchanged at 684 KB — `@stellar/stellar-sdk` is a peer
  dependency and isn't bundled, so **downstream consumers' bundle size is unaffected**
  by either the swap or the migration.
- **Memory:** runtime peak RSS is essentially flat; the cost is ~2× heap to load the
  SDK and higher transient allocation during XDR codec work.
- **Performance:** the class-XDR codec is **~5× slower** on the encode/decode hot path.
  Likely culprits: the `Proxy`-based native-int shims and richer class instantiation.
  This is an unoptimized draft ("will be moved to js-xdr") — the rewrite optimized for
  ergonomics/type-safety, not raw throughput, _yet_.
- **Docker:** this repo ships **no Dockerfile**, so there's no image to measure. The
  Docker-relevant proxy is the dependency footprint: a node image bundling
  `node_modules` would grow by roughly the **+36 MB** SDK delta (isolated) / **+20 MB**
  in this repo's full tree (559 MB vs 539 MB). Install time (a layer-build cost) is
  ~4.6× longer.

## Bottom line

The class-XDR API is a clear ergonomic/type-safety win and passes the full quality
pipeline and live testnet E2E here. As a draft it is meaningfully **heavier and slower**
(4× disk, ~5× XDR throughput, 2× import heap) and needs packaging fixes (js-xdr ESM
markers, installable-from-git build) before it's launch-ready. None of these block
correctness — they're size/perf/tooling polish.
