import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { verifyInvokeContractOp } from './verify-invoke.js'
import { StellarMppError } from './errors.js'

const NETWORK = Networks.TESTNET
const SOURCE_KP = Keypair.random()
const DESTINATION_ADDRESS = Keypair.random().publicKey()
const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function makeAccount(kp: Keypair = SOURCE_KP) {
  return new Account(kp.publicKey(), '0')
}

function buildInvokeContractTx(contractId: string = CONTRACT_ID, fnName = 'transfer') {
  const contract = new Contract(contractId)
  const op = contract.call(
    fnName,
    new Address(SOURCE_KP.publicKey()).toScVal(),
    new Address(DESTINATION_ADDRESS).toScVal(),
    nativeToScVal(1000000n, { type: 'i128' }),
  )
  return new TransactionBuilder(makeAccount(), {
    fee: '100',
    networkPassphrase: NETWORK,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}

describe('verifyInvokeContractOp', () => {
  // ── Happy path ───────────────────────────────────────────────────────

  it('returns contract address and invokeArgs for a valid invokeContract tx', () => {
    const tx = buildInvokeContractTx()
    const result = verifyInvokeContractOp(tx, '[test]')

    expect(result.contractAddress).toBe(CONTRACT_ID)
    expect(result.invokeArgs).toBeDefined()
    expect(result.invokeArgs.functionName.toString()).toBe('transfer')
  })

  it('returns correct contract address for different contract IDs', () => {
    const otherId = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
    const tx = buildInvokeContractTx(otherId)
    const result = verifyInvokeContractOp(tx, '[test]')

    expect(result.contractAddress).toBe(otherId)
  })

  it('exposes invokeArgs with correct argument count and values', () => {
    const tx = buildInvokeContractTx()
    const { invokeArgs } = verifyInvokeContractOp(tx, '[test]')

    const args = invokeArgs.args
    expect(args.length).toBe(3)

    const from = Address.fromScVal(args[0]).toString()
    expect(from).toBe(SOURCE_KP.publicKey())
    const to = Address.fromScVal(args[1]).toString()
    expect(to).toBe(DESTINATION_ADDRESS)
    const amount = nativeToScVal(1000000n, { type: 'i128' })
    expect(args[2].toXdr('hex')).toBe(amount.toXdr('hex'))
  })

  // ── Operation count ──────────────────────────────────────────────────

  it('rejects transaction with zero operations', () => {
    // Build a tx then strip operations via XDR manipulation
    const tx = buildInvokeContractTx()
    const envelope = tx.toEnvelope()
    envelope.v1.tx.operations = [] // clear operations
    const stripped = TransactionBuilder.fromXdr(envelope.toXdr('base64'), NETWORK) as typeof tx

    expect(() => verifyInvokeContractOp(stripped, '[test]')).toThrow(
      'must contain exactly one operation',
    )
  })

  it('rejects transaction with multiple operations and includes operationCount details', () => {
    const contract = new Contract(CONTRACT_ID)
    const op = contract.call('noop')
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(op)
      .addOperation(op)
      .addOperation(op)
      .setTimeout(30)
      .build()

    try {
      verifyInvokeContractOp(tx, '[test]')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StellarMppError)
      expect((err as StellarMppError).message).toContain(
        'must contain exactly one operation, got 3',
      )
      expect((err as StellarMppError).details.operationCount).toBe(3)
    }
  })

  // ── Non-invokeHostFunction operation types ───────────────────────────

  it('rejects a payment operation and includes operationType details', () => {
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '10',
        }),
      )
      .setTimeout(30)
      .build()

    try {
      verifyInvokeContractOp(tx, '[test]')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StellarMppError)
      expect((err as StellarMppError).message).toContain('does not contain a Soroban invocation')
      expect((err as StellarMppError).details.operationType).toBe('payment')
    }
  })

  it('rejects a createAccount operation and includes operationType details', () => {
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.createAccount({
          destination: Keypair.random().publicKey(),
          startingBalance: '10',
        }),
      )
      .setTimeout(30)
      .build()

    try {
      verifyInvokeContractOp(tx, '[test]')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StellarMppError)
      expect((err as StellarMppError).message).toContain('does not contain a Soroban invocation')
      expect((err as StellarMppError).details.operationType).toBe('createAccount')
    }
  })

  // ── Non-invokeContract host function types ───────────────────────────

  it('rejects extendFootprintTtl (not invokeHostFunction)', () => {
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.extendFootprintTtl({ extendTo: 1000 }))
      .setTimeout(30)
      .setSorobanData(new SorobanDataBuilder().build())
      .build()

    expect(() => verifyInvokeContractOp(tx, '[test]')).toThrow(
      'does not contain a Soroban invocation',
    )
  })

  it('rejects restoreFootprint (not invokeHostFunction)', () => {
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(30)
      .setSorobanData(new SorobanDataBuilder().build())
      .build()

    expect(() => verifyInvokeContractOp(tx, '[test]')).toThrow(
      'does not contain a Soroban invocation',
    )
  })

  it('rejects uploadWasm host function (invokeHostFunction but not invokeContract)', () => {
    const uploadWasmFn = xdr.HostFunction.hostFunctionTypeUploadContractWasm(
      Buffer.from('fake-wasm'),
    )
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.invokeHostFunction({ func: uploadWasmFn, auth: [] }))
      .setTimeout(30)
      .build()

    expect(() => verifyInvokeContractOp(tx, '[test]')).toThrow('not a contract invocation')
  })

  it('includes hostFunctionType in error details for non-invokeContract', () => {
    const uploadWasmFn = xdr.HostFunction.hostFunctionTypeUploadContractWasm(
      Buffer.from('fake-wasm'),
    )
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.invokeHostFunction({ func: uploadWasmFn, auth: [] }))
      .setTimeout(30)
      .build()

    try {
      verifyInvokeContractOp(tx, '[test]')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(StellarMppError)
      expect((err as StellarMppError).details.hostFunctionType).toBeDefined()
    }
  })

  // ── Error type and logPrefix propagation ─────────────────────────────

  it('includes logPrefix in all error messages', () => {
    const prefix = '[my:custom:prefix]'
    const tx = new TransactionBuilder(makeAccount(), {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(30)
      .build()

    expect(() => verifyInvokeContractOp(tx, prefix)).toThrow(prefix)
  })
})
