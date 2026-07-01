import { Address, Transaction, xdr } from '@stellar/stellar-sdk'
import { StellarMppError } from './errors.js'

/**
 * Verify that a transaction contains exactly one `invokeHostFunction`
 * operation of type `invokeContract`, and return the target contract
 * address, the raw invoke-contract args, and the operation's authorization
 * entries.
 *
 * Used by both Charge and Channel servers to reject malformed or
 * unexpected Soroban transactions before broadcasting.
 *
 * @throws {StellarMppError} if the transaction structure is invalid
 */
export function verifyInvokeContractOp(
  tx: Transaction,
  logPrefix: string,
): {
  contractAddress: string
  invokeArgs: xdr.InvokeContractArgs
  authEntries: xdr.SorobanAuthorizationEntry[]
} {
  if (tx.operations.length !== 1) {
    throw new StellarMppError(
      `${logPrefix} Transaction must contain exactly one operation, got ${tx.operations.length}.`,
      { operationCount: tx.operations.length },
    )
  }

  const op = tx.operations[0]
  if (op.type !== 'invokeHostFunction') {
    throw new StellarMppError(`${logPrefix} Transaction does not contain a Soroban invocation.`, {
      operationType: op.type,
    })
  }

  const invokeHostFnOp = tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp()
  const hostFn = invokeHostFnOp.hostFunction()

  if (hostFn.switch().value !== xdr.HostFunctionType.hostFunctionTypeInvokeContract().value) {
    throw new StellarMppError(`${logPrefix} Host function is not a contract invocation.`, {
      hostFunctionType: hostFn.switch().name,
    })
  }

  const invokeArgs = hostFn.invokeContract()
  const contractAddress = Address.fromScAddress(invokeArgs.contractAddress()).toString()

  return { contractAddress, invokeArgs, authEntries: invokeHostFnOp.auth() }
}
