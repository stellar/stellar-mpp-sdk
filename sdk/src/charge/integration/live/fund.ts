import type { Server as SorobanServer } from '@stellar/stellar-sdk/rpc'

// Test-only helper for the live integration suite; not part of the published SDK.
//
// Friendbot and the Soroban RPC are separate services: friendbot submits the
// funding tx via Horizon, and the RPC ingests it a few ledgers later. fundAddress
// polls the RPC immediately, so it can throw NOT_FOUND / "Account not found" even
// though funding succeeded. Retry against account visibility, tolerating the lag
// and the "already funded" error from a prior attempt that did land.
//
// The RPC endpoint is load balanced, so a single success only proves one node has
// ingested the account. Require consecutive successes before returning, otherwise
// the caller's next request can still land on a node that is behind.
const VISIBILITY_STREAK = 3

export async function fundResilient(
  server: SorobanServer,
  pubkey: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadlineMs = Date.now() + timeoutMs
  let streak = 0
  let lastError: unknown
  while (Date.now() < deadlineMs) {
    try {
      await server.getAccount(pubkey)
      if (++streak >= VISIBILITY_STREAK) return
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      continue
    } catch (err) {
      streak = 0
      lastError = err
    }
    try {
      await server.fundAddress(pubkey)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  throw new Error(
    `Funding ${pubkey} timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
