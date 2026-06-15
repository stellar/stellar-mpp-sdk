# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-06-15

### Security

- Harden charge and channel payment verification ([#47](https://github.com/stellar/stellar-mpp-sdk/pull/47))
  - Add a payer-bound `signedHash` push credential (tx hash + `sourceSignature` over `"{challenge.id}:{hash}"`), verified against the key controlling the on-chain transfer's `from`.
  - Advertise accepted credential types via `methodDetails.credentialTypes` so clients detect unsupported settlement modes before paying; sponsored (`feePayer`) servers advertise pull mode only.
  - Accept only payer-authenticated push (`signedHash`) and pull (`transaction`) credentials by default; legacy unsigned `hash` push is no longer accepted unless an operator opts in with `allowUnsignedPush: true`, which logs each acceptance for migration tracking.
  - Require an atomic store (one providing `update()` compare-and-set) for both charge and channel servers, validated at construction with a clear error.
  - Channel: require explicit commitment pinning on the client, verify the simulated commitment matches the pinned channel, intended amount, network, and domain before signing, reject credentials during the on-chain close settling window, add an opt-in per-funder fee budget, and warn at startup when a fee-bump signer is configured without one.
  - Channel: document that the server store's `update()` must be a linearizable compare-and-set (a get-then-put or eventually-consistent backend is not sufficient for multi-process deployments), with single- and multi-process reference implementations.
  - Charge: document the same linearizable compare-and-set store requirement (store JSDoc and README), and strengthen the cross-process replay test to assert exactly one acceptance and one rejection.
  - Charge: deduplicate pull-mode settlements by transaction hash (shared with push mode), and warn when a fee-bump signer is configured.

### Changed

- Tighten the dependency supply chain ([#47](https://github.com/stellar/stellar-mpp-sdk/pull/47))
  - Add a 7-day `minimumReleaseAge` pnpm setting as a supply-chain guard.
  - Upgrade all dependencies to the newest versions satisfying it.
  - Tighten the `@stellar/stellar-sdk` and `mppx` peer ranges to the tested versions.

### Removed

- **BREAKING:** Remove the non-functional channel `open` MPP action ([#47](https://github.com/stellar/stellar-mpp-sdk/pull/47))
  - Drop the `open` credential action, the server-side open settlement path, and the `examples/channel-open.ts` example.
  - The one-way-channel contract is created by its constructor at deploy time and has no on-chain open entrypoint, so the MPP open path was dead code. Deploy the channel out-of-band (e.g. with the `stellar` CLI); off-chain vouchers and on-chain close are unchanged.

## [0.6.0] - 2026-05-26

### Changed

- **BREAKING:** Upgrade the `mppx` peer dependency to `^0.6.28` (from `^0.4.11`) — consumers must use mppx 0.6.x. No SDK API changes; the integration is source-compatible. Bump `zod` to `^4.4.3` (required by mppx 0.6) and add `viem` (mppx 0.6 peer) ([#46](https://github.com/stellar/stellar-mpp-sdk/pull/46))
- **BREAKING:** Require Node.js `>=22` (from `>=20`). mppx 0.6 pulls transitive dependencies (`incur`, `@scalar/openapi-types`) that require Node 22 ([#46](https://github.com/stellar/stellar-mpp-sdk/pull/46))
- Upgrade TypeScript to 6.0.3 ([#46](https://github.com/stellar/stellar-mpp-sdk/pull/46))

### Fixed

- Resolve Dependabot alerts: bump `qs` and `ip-address` (via `express-rate-limit`), and clear the transitive `ws` advisory via viem 2.50.4 ([#46](https://github.com/stellar/stellar-mpp-sdk/pull/46))

### Security

- Constrain the `viem` range to `>=2.50.4 <2.51.0 || >2.51.0`. viem 2.51.0 resolves its `ox` dependency from a non-registry `pkg.pr.new` preview tarball — a mutable, unaudited source unfit for a published SDK's lockfile. The range excludes only 2.51.0 while still allowing 2.50.x patches and future clean releases ([#46](https://github.com/stellar/stellar-mpp-sdk/pull/46))

## [0.5.1] - 2026-04-21

### Added

- End-to-End tests for the charge intent, submitting real transactions on Testnet, and making sure the flows work in combinations of push/pull and sponsorship ([#41](https://github.com/stellar/stellar-mpp-sdk/pull/41))

### Fixed

- Fix push-mode DoS via semaphore exhaustion: replace unbounded polling with single `getTransaction` lookup, add schema-level XDR size cap and hash format validation ([#44](https://github.com/stellar/stellar-mpp-sdk/pull/44))

## [0.5.0] - 2026-04-13

- Harden verification, replay protection, fix sponsored charge path, and replace SAC terminology with SEP-41 across docs, comments, and error messages ([#42](https://github.com/stellar/stellar-mpp-sdk/pull/42))

## [0.4.0] - 2026-04-01

### Changed

- **BREAKING:** Make `store` required in `channel()` server — channel security model (replay protection, cumulative tracking, post-close rejection) depends entirely on the store; add startup info log advising multi-process deployments to use atomic put-if-absent semantics [#38](https://github.com/stellar/stellar-mpp-sdk/pull/38)
- **BREAKING:** Verify SEP-41 transfer `from` address against credential source in both push and pull modes — `credential.source` (DID) is now mandatory; prevents hash-theft attacks where a third party intercepts a client's tx hash and claims the payment benefit before the legitimate client can [#38](https://github.com/stellar/stellar-mpp-sdk/pull/38)
- Nest channel server `signer` + `feeBumpSigner` into `feePayer: { envelopeSigner, feeBumpSigner? }` to match charge server convention [#34](https://github.com/stellar/stellar-mpp-sdk/pull/34)

### Added

- Optional client-side `store` to `channel()` client — persists signed cumulative and uses `max(local, server-reported)` as baseline, preventing a rogue server from resetting the client's cumulative state [#38](https://github.com/stellar/stellar-mpp-sdk/pull/38)

### Fixed

- Fix charge client so it sends a transaction with signed auth entries when the server is sponsoring transaction fees ([#37](https://github.com/stellar/stellar-mpp-sdk/pull/37))
- Fix CHANGELOG entries for v0.3.0 ([#36](https://github.com/stellar/stellar-mpp-sdk/pull/36))

## [0.3.0] - 2026-03-31

### Added

- Add [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00) spec references to README, JSDoc, and charge-flow diagram; fix diagram for spec compliance [#35](https://github.com/stellar/stellar-mpp-sdk/pull/35)

### Changed

- Align fee-bump transaction handling with the spec and restructure server signer configuration (`feePayer`) to match cross-chain conventions [#33](https://github.com/stellar/stellar-mpp-sdk/pull/33)
- Nest channel server `signer` + `feeBumpSigner` into `feePayer: { envelopeSigner, feeBumpSigner? }` to match charge server convention [#34](https://github.com/stellar/stellar-mpp-sdk/pull/34)

## [0.2.1] - 2026-03-30

### Fixed

- Bump `path-to-regexp` (8.3.0 → 8.4.0), `picomatch` (4.0.3 → 4.0.4), and `yaml` (2.8.2 → 2.8.3) to address security vulnerabilities (CVE-2026-4926, CVE-2026-4923, CVE-2026-33671, CVE-2026-33672) [#28](https://github.com/stellar/stellar-mpp-sdk/pull/28)

### Changed

- Rewrote the Install section in the README to focus on npm package consumers, with peer dependency callout and subpath import examples [#29](https://github.com/stellar/stellar-mpp-sdk/pull/29)
- Add CHANGELOG and release structure for v0.2.x [#31](https://github.com/stellar/stellar-mpp-sdk/pull/31)

## [0.2.0] - 2026-03-30

### Added

- Initial release of `@stellar/mpp` — a TypeScript SDK for Stellar blockchain payment methods in the Machine Payments Protocol (MPP)
- **Charge module**: one-time on-chain SEP-41 token transfers with pull (transaction credential) and push (hash credential) modes, following the [draft-stellar-charge-00](https://paymentauth.org/draft-stellar-charge-00) specification
- **Channel module**: off-chain payment commitments via one-way payment channel contracts with batch settlement on close (session spec in progress)
- Subpath exports for selective imports (`@stellar/mpp/charge/client`, `@stellar/mpp/charge/server`, `@stellar/mpp/channel/client`, `@stellar/mpp/channel/server`, `@stellar/mpp/env`)
- Env parsing primitives for Stellar-aware configuration
- Shared utilities: fee bump wrapping, transaction polling with backoff, Soroban simulation, unit conversion, keypair resolution

[Unreleased]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/stellar/stellar-mpp-sdk/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/stellar/stellar-mpp-sdk/releases/tag/v0.2.0
