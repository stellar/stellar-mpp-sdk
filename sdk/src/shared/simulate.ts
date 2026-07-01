import { FeeBumpTransaction, Transaction, rpc } from '@stellar/stellar-sdk'
import { DEFAULT_SIMULATION_TIMEOUT_MS } from './defaults.js'

export class SimulationContractError extends Error {
  constructor(
    message: string,
    public readonly simulationError: string,
  ) {
    super(message)
    this.name = 'SimulationContractError'
  }
}

export class SimulationNetworkError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown,
  ) {
    super(message)
    this.name = 'SimulationNetworkError'
  }
}

export class SimulationTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimulationTimeoutError'
  }
}

export interface SimulateOptions {
  timeoutMs?: number
  /**
   * Authorization mode passed to the RPC. Defaults to the RPC's recording mode,
   * which ignores any supplied authorization. Use `'enforce'` to validate the
   * supplied authorization entries against ledger state before relying on the
   * simulation result.
   */
  authMode?: rpc.Api.SimulationAuthMode
}

/**
 * Simulates a Soroban transaction with a configurable timeout.
 *
 * Wraps {@link rpc.Server.simulateTransaction} in a `Promise.race` against a
 * timeout and classifies failures into three error types:
 *
 * - {@link SimulationContractError} — the RPC responded but the simulation
 *   itself failed (e.g. contract trap, insufficient auth).
 * - {@link SimulationTimeoutError} — the RPC did not respond within `timeoutMs`.
 * - {@link SimulationNetworkError} — a transport-level failure (DNS, TLS, etc.).
 *
 * @param rpcServer - Soroban RPC server instance.
 * @param tx - The transaction to simulate.
 * @param opts - Optional settings (currently only `timeoutMs`).
 * @returns The successful simulation response including `result.retval`.
 */
export async function simulateCall(
  rpcServer: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
  opts: SimulateOptions = {},
): Promise<rpc.Api.SimulateTransactionSuccessResponse> {
  const { timeoutMs = DEFAULT_SIMULATION_TIMEOUT_MS, authMode } = opts

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      rpcServer.simulateTransaction(tx, undefined, authMode),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SimulationTimeoutError(`Simulation timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
    clearTimeout(timer)

    if (!rpc.Api.isSimulationSuccess(result)) {
      const errorMsg = rpc.Api.isSimulationError(result) ? result.error : 'unknown error'
      throw new SimulationContractError(`Simulation failed: ${errorMsg}`, errorMsg)
    }

    return result
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof SimulationContractError || err instanceof SimulationTimeoutError) {
      throw err
    }
    throw new SimulationNetworkError(
      `Simulation network error: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }
}
