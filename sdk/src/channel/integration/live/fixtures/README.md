# Channel contract fixture

`channel.wasm` is the one-way-channel contract that the live parity test deploys on testnet. Rebuild it when the contract's commitment encoding changes.

- Source: https://github.com/stellar-experimental/one-way-channel at commit `92a6c0462aede3a4a79a5418a18dda996e4597c5`
- Build: `stellar contract build --package channel` (stellar CLI 28.1.0, rustc 1.94.1, target `wasm32v1-none`)
- Output: `target/wasm32v1-none/release/channel.wasm`
- SHA-256: `53d78c2ea887f6dbe2d5f59b0ca2be06d4618a38f9b326b354345b52471602af`
