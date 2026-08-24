import type { rpc } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, type NetworkId } from '../constants.js'
import { DEFAULT_SIMULATION_TIMEOUT_MS } from './defaults.js'
import { StellarMppError } from './errors.js'
import { withTimeout } from './timeout.js'

/**
 * Endpoints already confirmed to serve a given network, keyed by URL.
 *
 * A repointed endpoint is not re-checked for the lifetime of the process. That
 * is the trade for not paying a round trip per payment, and it is safe because
 * the value being cached is the endpoint's own answer about which chain it is
 * on, which does not change in normal operation.
 */
const confirmedEndpoints = new Map<string, string>()

/**
 * Confirms an RPC endpoint serves `network` before it is used to read chain
 * state, so contract simulation and the resulting signature cannot be based on
 * two different chains.
 *
 * A URL is an unverified claim about which chain is behind it. Only the
 * endpoint can settle it, so this asks it directly rather than pattern-matching
 * the URL — a self-hosted or gateway address is indistinguishable otherwise.
 *
 * Intended for caller-supplied URLs only: a URL the SDK derived from the
 * resolved network is already bound to it by construction, and checking it
 * would cost a round trip to learn nothing.
 *
 * @param server - RPC client for `rpcUrl`.
 * @param rpcUrl - The endpoint being checked, used only as the cache key.
 * @param network - The network the caller intends to transact on.
 * @param timeoutMs - Maximum time to wait for the endpoint to answer.
 */
export async function assertRpcServesNetwork(
  server: Pick<rpc.Server, 'getNetwork'>,
  rpcUrl: string,
  network: NetworkId,
  timeoutMs: number = DEFAULT_SIMULATION_TIMEOUT_MS,
): Promise<void> {
  const expected = NETWORK_PASSPHRASE[network]
  if (confirmedEndpoints.get(rpcUrl) === expected) return

  const { passphrase } = await withTimeout(
    server.getNetwork(),
    timeoutMs,
    'RPC network identification',
  )

  // The URL is deliberately left out of the message: RPC endpoints commonly
  // carry an API key in the URL, and errors reach logs and progress callbacks.
  if (passphrase !== expected) {
    throw new StellarMppError(
      `The configured RPC endpoint does not serve "${network}". ` +
        'Point rpcUrl at that network, or remove it to use the default endpoint.',
    )
  }

  confirmedEndpoints.set(rpcUrl, passphrase)
}
