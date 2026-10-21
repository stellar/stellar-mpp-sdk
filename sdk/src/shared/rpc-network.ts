import type { rpc } from '@stellar/stellar-sdk'
import { NETWORK_PASSPHRASE, type NetworkId } from '../constants.js'
import { DEFAULT_SIMULATION_TIMEOUT_MS } from './defaults.js'
import { StellarMppError } from './errors.js'
import { TimeoutError, withTimeout } from './timeout.js'

/**
 * Endpoints already confirmed to serve a given network, keyed by URL.
 *
 * A confirmed endpoint is not re-checked for the lifetime of the process, so a
 * payment does not pay a round trip for it. The cache holds the endpoint's own
 * answer about its chain, which does not change in normal operation; a process
 * restart re-checks every endpoint.
 */
const confirmedEndpoints = new Map<string, string>()

/**
 * Confirms an RPC endpoint serves `network` before it is used to read chain
 * state, so contract simulation and the resulting signature are based on the
 * same chain.
 *
 * A URL says nothing about which chain is behind it, and a self-hosted or
 * gateway address cannot be told apart by pattern. Only the endpoint can
 * answer, so this asks it directly.
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

  // The URL is deliberately left out of every message below: RPC endpoints
  // commonly carry an API key in the URL, and errors reach logs and progress
  // callbacks.
  let passphrase: string
  try {
    ;({ passphrase } = await withTimeout(
      server.getNetwork(),
      timeoutMs,
      'RPC network identification',
    ))
  } catch (error) {
    if (error instanceof TimeoutError) throw error
    throw new StellarMppError('The configured RPC endpoint did not identify its network.', {
      details: error instanceof Error ? error.message : String(error),
    })
  }

  if (passphrase !== expected) {
    throw new StellarMppError(
      `The configured RPC endpoint does not serve "${network}". ` +
        'Point rpcUrl at that network, or remove it to use the default endpoint.',
    )
  }

  confirmedEndpoints.set(rpcUrl, passphrase)
}
