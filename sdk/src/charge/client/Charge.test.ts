import {
  Account,
  Address,
  Contract,
  Keypair,
  Memo,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  authorizeInvocation,
  buildAuthorizationEntryPreimage,
  hash,
  nativeToScVal,
  xdr,
  scValToNative,
  Transaction,
} from '@stellar/stellar-sdk'
import { Challenge } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import {
  ALL_ZEROS,
  NETWORK_PASSPHRASE,
  STELLAR_TESTNET,
  USDC_SAC_TESTNET,
} from '../../constants.js'
import { StellarMppError } from '../../shared/errors.js'

// ── Mocks ──────────────────────────────────────────────────────────────────
const mockGetAccount = vi.fn()
const mockPrepareTransaction = vi.fn()
const mockGetLatestLedger = vi.fn()
const mockSendTransaction = vi.fn()
const mockGetTransaction = vi.fn()
const mockSimulateTransaction = vi.fn()

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
        this.getAccount = mockGetAccount
        this.prepareTransaction = mockPrepareTransaction
        this.getLatestLedger = mockGetLatestLedger
        this.sendTransaction = mockSendTransaction
        this.getTransaction = mockGetTransaction
        this.simulateTransaction = mockSimulateTransaction
      }),
    },
  }
})

const { charge } = await import('./Charge.js')

const TEST_KEYPAIR = Keypair.random()
const RECIPIENT = Keypair.random().publicKey()

function mockChallenge(overrides: Record<string, unknown> = {}) {
  return Challenge.from({
    id: `test-${crypto.randomUUID()}`,
    realm: 'localhost',
    method: 'stellar',
    intent: 'charge',
    request: {
      amount: '100000',
      currency: USDC_SAC_TESTNET,
      recipient: RECIPIENT,
      methodDetails: {
        network: 'stellar:testnet',
      },
      ...overrides,
    },
  })
}

function buildMockPreparedTx() {
  const account = new Account(TEST_KEYPAIR.publicKey(), '0')
  const contract = new Contract(USDC_SAC_TESTNET)
  const transferOp = contract.call(
    'transfer',
    new Address(TEST_KEYPAIR.publicKey()).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(100000n, { type: 'i128' }),
  )
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
}

function buildMockPrepareTxAuthEntry() {
  const account = new Account(ALL_ZEROS, '0')
  const contract = new Contract(USDC_SAC_TESTNET)
  const transferOp = contract.call(
    'transfer',
    new Address(TEST_KEYPAIR.publicKey()).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(100000n, { type: 'i128' }),
  )
  authorizeInvocation({
    signer: TEST_KEYPAIR,
    validUntilLedgerSeq: 1000,
    invocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: contract.address().toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(TEST_KEYPAIR.publicKey(), { type: 'address' }),
            nativeToScVal(RECIPIENT, { type: 'address' }),
            nativeToScVal(100000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    }),
    networkPassphrase: NETWORK_PASSPHRASE[STELLAR_TESTNET],
  }).then((auth) => {
    transferOp.body().invokeHostFunctionOp().auth().push(auth)
  })
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
}

const ATTACKER = Keypair.random().publicKey()
const OTHER_TOKEN = 'CAYGVE5AUQQ2XNXWOXHH5VPGRHYX4APUAOWA4VOBI3VGMOYJ2IJ6VJG5'

function transferArgs(from: string, to: string, amount: bigint) {
  return [
    nativeToScVal(from, { type: 'address' }),
    nativeToScVal(to, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
  ]
}

function transferInvocation(
  contractAddress: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractAddress).toScAddress(),
        functionName: 'transfer',
        args,
      }),
    ),
    subInvocations,
  })
}

// Builds a prepared transaction whose single transfer operation carries one
// Soroban authorization entry with the given root invocation. Used to model a
// malicious `currency` contract whose auth tree differs from the intended
// transfer the client believes it is paying.
async function buildTxWithAuthInvocation(opts: {
  source: string
  rootInvocation: xdr.SorobanAuthorizedInvocation
}) {
  const account = new Account(opts.source, '0')
  const contract = new Contract(USDC_SAC_TESTNET)
  const transferOp = contract.call(
    'transfer',
    new Address(TEST_KEYPAIR.publicKey()).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(100000n, { type: 'i128' }),
  )
  const auth = await authorizeInvocation({
    signer: TEST_KEYPAIR,
    validUntilLedgerSeq: 1000,
    invocation: opts.rootInvocation,
    networkPassphrase: NETWORK_PASSPHRASE[STELLAR_TESTNET],
  })
  transferOp.body().invokeHostFunctionOp().auth().push(auth)
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE[STELLAR_TESTNET],
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
}

type CredentialArm = 'address' | 'addressV2' | 'addressWithDelegates'

// Models what `prepareTransaction` hands back in recording mode: a transfer op
// carrying one *unsigned* auth entry for the client, under the given credential
// arm. V1 is what pre-CAP-71 RPCs return; V2 is what an RPC (or SDK) opted into
// upgraded auth returns.
function buildTxWithUnsignedAuthEntry(arm: CredentialArm) {
  const account = new Account(ALL_ZEROS, '0')
  const contract = new Contract(USDC_SAC_TESTNET)
  const transferOp = contract.call(
    'transfer',
    new Address(TEST_KEYPAIR.publicKey()).toScVal(),
    new Address(RECIPIENT).toScVal(),
    nativeToScVal(100000n, { type: 'i128' }),
  )
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: new Address(TEST_KEYPAIR.publicKey()).toScAddress(),
    nonce: new xdr.Int64(1),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  const credentials =
    arm === 'address'
      ? xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials)
      : arm === 'addressV2'
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
            new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials, delegates: [] }),
          )
  transferOp
    .body()
    .invokeHostFunctionOp()
    .auth([
      new xdr.SorobanAuthorizationEntry({
        credentials,
        rootInvocation: transferInvocation(
          USDC_SAC_TESTNET,
          transferArgs(TEST_KEYPAIR.publicKey(), RECIPIENT, 100000n),
        ),
      }),
    ])
  return new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE[STELLAR_TESTNET],
  })
    .addOperation(transferOp)
    .setTimeout(180)
    .build()
}

async function createSponsoredCredentialAuthEntry(arm: CredentialArm) {
  mockGetAccount.mockResolvedValueOnce(new Account(TEST_KEYPAIR.publicKey(), '0'))
  mockPrepareTransaction.mockResolvedValueOnce(buildTxWithUnsignedAuthEntry(arm))
  mockGetLatestLedger.mockResolvedValueOnce({ sequence: 50 })

  const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
  const challenge = mockChallenge({
    methodDetails: { network: 'stellar:testnet', feePayer: true },
  })
  const credential = await method.createCredential({
    challenge: challenge as any,
    context: {} as any,
  })
  const token = credential.replace(/^Payment\s+/, '')
  const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
  const tx = TransactionBuilder.fromXDR(
    decoded.payload.transaction,
    NETWORK_PASSPHRASE[STELLAR_TESTNET],
  ) as Transaction
  const op = tx.operations[0] as Operation.InvokeHostFunction
  expect(op.auth?.length).toBe(1)
  return op.auth![0]
}

// Checks the client's signature independently of the SDK's own verifier: the
// signature must be over the preimage the network derives for the entry's arm.
function expectSignedByClientOverArmPreimage(
  entry: xdr.SorobanAuthorizationEntry,
  addressCredentials: xdr.SorobanAddressCredentials,
) {
  const [sig] = scValToNative(addressCredentials.signature()) as Array<{
    public_key: Uint8Array
    signature: Uint8Array
  }>
  expect(Buffer.from(sig.public_key)).toEqual(TEST_KEYPAIR.rawPublicKey())
  const payload = hash(
    buildAuthorizationEntryPreimage(
      entry,
      addressCredentials.signatureExpirationLedger(),
      NETWORK_PASSPHRASE[STELLAR_TESTNET],
    ).toXDR(),
  )
  expect(TEST_KEYPAIR.verify(payload, Buffer.from(sig.signature))).toBe(true)
}

// Models a successful recording-mode simulation for the sponsored transfer,
// returning one unsigned auth entry for the client under the given arm. This is
// what the RPC returns to `simulateTransaction` (V2 when `useUpgradedAuth` is
// set), and what `assembleTransaction` folds into the prepared tx.
function mockSimulationWithAuthEntry(arm: 'address' | 'addressV2') {
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: new Address(TEST_KEYPAIR.publicKey()).toScAddress(),
    nonce: new xdr.Int64(1),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  })
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials:
      arm === 'address'
        ? xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials),
    rootInvocation: transferInvocation(
      USDC_SAC_TESTNET,
      transferArgs(TEST_KEYPAIR.publicKey(), RECIPIENT, 100000n),
    ),
  })
  return {
    _parsed: true,
    id: 'sim-1',
    latestLedger: 50,
    events: [],
    minResourceFee: '100',
    transactionData: new SorobanDataBuilder(),
    result: { auth: [entry], retval: xdr.ScVal.scvVoid() },
  }
}

// ── Construction tests ─────────────────────────────────────────────────────

describe('stellar client charge', () => {
  it('creates a client method with correct name and intent', () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('charge')
  })

  it('accepts secretKey parameter', () => {
    const method = charge({ secretKey: TEST_KEYPAIR.secret() })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('charge')
  })

  it('has createCredential function', () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    expect(typeof method.createCredential).toBe('function')
  })

  it('throws when neither keypair nor secretKey is provided', () => {
    expect(() => charge({} as any)).toThrow('Either keypair or secretKey must be provided')
  })
})

// ── createCredential behaviour ─────────────────────────────────────────────

describe('charge createCredential', () => {
  it('rejects push mode with server-sponsored fee (feePayer=true)', async () => {
    const method = charge({ keypair: TEST_KEYPAIR, mode: 'push' })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Push mode is not supported for server-sponsored transactions')
  })

  it('allows overriding mode via context', async () => {
    // Default mode is pull, but context can override to push
    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })

    // Push via context + feePayer should still throw
    await expect(
      method.createCredential({
        challenge: challenge as any,
        context: { mode: 'push' } as any,
      }),
    ).rejects.toThrow('Push mode is not supported for server-sponsored transactions')
  })

  it('fires onProgress events during unsponsored pull flow', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

    const events: unknown[] = []
    const method = charge({
      keypair: TEST_KEYPAIR,
      onProgress: (e) => events.push(e),
    })

    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Verify progress events were emitted in order
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect((events[0] as any).type).toBe('challenge')
    expect((events[0] as any).recipient).toBe(RECIPIENT)
    expect((events[1] as any).type).toBe('signing')
    expect((events[2] as any).type).toBe('signed')
    expect((events[2] as any).transaction).toBeDefined()

    // Credential should be a string (serialized)
    expect(typeof credential).toBe('string')
    expect(credential).toMatch(/^Payment\s+/)
  })

  it('produces a transaction credential in pull mode', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge()

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Decode the credential
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))

    expect(decoded.payload.type).toBe('transaction')
    expect(typeof decoded.payload.transaction).toBe('string')
    expect(decoded.source).toMatch(/^did:pkh:stellar:testnet:G/)
  })

  it('produces an auth entry credential in pull mode, when sponsored', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPrepareTxAuthEntry()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 50 })

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Decode the credential and transaction
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    const tx = TransactionBuilder.fromXDR(
      decoded.payload.transaction,
      NETWORK_PASSPHRASE[STELLAR_TESTNET],
    ) as Transaction
    const op = tx.operations[0] as Operation.InvokeHostFunction

    // Should still be a valid transaction payload, but an unsigned envelope
    expect(decoded.payload.type).toBe('transaction')
    expect(tx.source).toBe(ALL_ZEROS)
    expect(tx.signatures.length).toBe(0)
    expect(tx.operations.length).toBe(1)
    expect(op.type).toBe('invokeHostFunction')

    // The Operation and auth entry should be valid
    expect(op.source).toBe(undefined)
    expect(op.auth?.length).toBe(1)
    const auth = op.auth![0]
    expect(auth).toBeDefined()
    expect(auth.rootInvocation().subInvocations().length).toBe(0)

    // The address credential should be valid
    const cred = auth.credentials()
    expect(cred.switch().name).toBe('sorobanCredentialsAddress')
    expect(Address.fromScAddress(cred.address().address()).toString()).toBe(
      TEST_KEYPAIR.publicKey(),
    )
    expect(cred.address().signature()).toBeDefined()
    expect(cred.address().nonce()).toBeDefined()
    expect(cred.address().signatureExpirationLedger()).toBeDefined()

    // The authorized function invocation should be valid
    const func = auth.rootInvocation().function().contractFn()
    expect(Address.fromScAddress(func.contractAddress()).toString()).toBe(USDC_SAC_TESTNET)
    expect(func.functionName().toString()).toBe('transfer')

    // The authorized function args should be valid
    const args = func.args()
    expect(args.length).toBe(3)
    expect(scValToNative(args[0])).toBe(TEST_KEYPAIR.publicKey())
    expect(scValToNative(args[1])).toBe(RECIPIENT)
    expect(scValToNative(args[2])).toBe(100000n)
  })

  it('broadcasts and produces signedHash credential with sourceSignature in push mode when server advertises signedHash', async () => {
    mockGetAccount.mockClear()
    mockPrepareTransaction.mockClear()
    mockSendTransaction.mockClear()
    mockGetTransaction.mockClear()

    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)
    mockSendTransaction.mockResolvedValueOnce({ hash: 'push-tx-hash-abc' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const events: unknown[] = []
    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'push',
      onProgress: (e) => events.push(e),
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['transaction', 'signedHash', 'hash'],
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Should have additional push-mode events
    const types = events.map((e: any) => e.type)
    expect(types).toContain('paying')
    expect(types).toContain('confirming')
    expect(types).toContain('paid')

    // Decode to verify signedHash payload and sourceSignature
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.type).toBe('signedHash')
    expect(decoded.payload.hash).toBe('push-tx-hash-abc')

    // Verify sourceSignature is a valid 64-byte (128 hex char) signature
    expect(decoded.payload.sourceSignature).toMatch(/^[0-9a-f]{128}$/i)

    // Verify the signature is correct: sign "{challenge.id}:{canonicalHash}"
    const expectedSig = Buffer.from(
      TEST_KEYPAIR.sign(Buffer.from(`${challenge.id}:push-tx-hash-abc`)),
    ).toString('hex')
    expect(decoded.payload.sourceSignature).toBe(expectedSig)
  })

  it('throws in push mode when server does NOT advertise signedHash', async () => {
    mockGetAccount.mockClear()
    mockPrepareTransaction.mockClear()
    mockSendTransaction.mockClear()
    mockGetTransaction.mockClear()

    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'push',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['transaction', 'hash'],
      },
    })

    // Should throw BEFORE any RPC calls (before building/broadcasting)
    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('signedHash')

    // Verify sendTransaction was never called (fund safety check)
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('throws in push mode when credentialTypes is absent (legacy server)', async () => {
    mockGetAccount.mockClear()
    mockPrepareTransaction.mockClear()
    mockSendTransaction.mockClear()
    mockGetTransaction.mockClear()

    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'push',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        // No credentialTypes field
      },
    })

    // Should throw BEFORE any RPC calls
    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('signedHash')

    // Verify sendTransaction was never called
    expect(mockSendTransaction).not.toHaveBeenCalled()
  })

  it('proceeds in pull mode when credentialTypes includes transaction', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'pull',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['transaction', 'signedHash'],
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Should produce a transaction credential
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.type).toBe('transaction')
  })

  it('throws in pull mode when credentialTypes does NOT include transaction', async () => {
    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'pull',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['signedHash', 'hash'],
      },
    })

    // Should throw before signing
    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('transaction')
  })

  it('proceeds in pull mode when credentialTypes is absent (legacy server)', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'pull',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        // No credentialTypes: legacy servers default to supporting transaction
      },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Should produce a transaction credential (legacy behavior)
    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.payload.type).toBe('transaction')
  })

  it('never emits type:hash in any code path', async () => {
    // Test pull mode
    {
      const account = new Account(TEST_KEYPAIR.publicKey(), '0')
      mockGetAccount.mockResolvedValueOnce(account)
      const mockTx = buildMockPreparedTx()
      mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

      const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
      const challenge = mockChallenge()

      const credential = await method.createCredential({
        challenge: challenge as any,
        context: {} as any,
      })

      const token = credential.replace(/^Payment\s+/, '')
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
      expect(decoded.payload.type).not.toBe('hash')
    }

    // Reset mocks
    mockGetAccount.mockClear()
    mockPrepareTransaction.mockClear()
    mockSendTransaction.mockClear()
    mockGetTransaction.mockClear()

    // Test push mode
    {
      const account = new Account(TEST_KEYPAIR.publicKey(), '0')
      mockGetAccount.mockResolvedValueOnce(account)
      const mockTx = buildMockPreparedTx()
      mockPrepareTransaction.mockResolvedValueOnce(await mockTx)
      mockSendTransaction.mockResolvedValueOnce({ hash: 'push-tx-hash-xyz' })
      mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

      const method = charge({ keypair: TEST_KEYPAIR, mode: 'push' })
      const challenge = mockChallenge({
        methodDetails: {
          network: 'stellar:testnet',
          credentialTypes: ['transaction', 'signedHash'],
        },
      })

      const credential = await method.createCredential({
        challenge: challenge as any,
        context: {} as any,
      })

      const token = credential.replace(/^Payment\s+/, '')
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
      expect(decoded.payload.type).not.toBe('hash')
      expect(decoded.payload.type).toBe('signedHash')
    }
  })

  it('does not add a transaction memo in push mode (Soroban transactions cannot have memos)', async () => {
    mockGetAccount.mockClear()
    mockPrepareTransaction.mockClear()
    mockSendTransaction.mockClear()
    mockGetTransaction.mockClear()

    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)

    let capturedTransaction: any
    mockPrepareTransaction.mockImplementation((tx: any) => {
      capturedTransaction = tx
      return Promise.resolve(tx)
    })

    mockSendTransaction.mockResolvedValueOnce({ hash: 'push-tx-hash-no-memo', status: 'PENDING' })
    mockGetTransaction.mockResolvedValueOnce({ status: 'SUCCESS' })

    const method = charge({
      keypair: TEST_KEYPAIR,
      mode: 'push',
    })
    const challenge = mockChallenge({
      methodDetails: {
        network: 'stellar:testnet',
        credentialTypes: ['transaction', 'signedHash'],
      },
    })

    await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Verify the transaction has no memo (Soroban rejects memos)
    expect(capturedTransaction).toBeDefined()
    // TransactionBuilder uses Memo.none() by default, not undefined
    expect(capturedTransaction.memo.type).toBe('none')
  })

  // ── CAP-71 credential arms in the sponsored path ─────────────────────────

  it('signs a V1 auth entry returned by simulation over the legacy preimage', async () => {
    const auth = await createSponsoredCredentialAuthEntry('address')

    const cred = auth.credentials()
    expect(cred.switch().name).toBe('sorobanCredentialsAddress')
    expectSignedByClientOverArmPreimage(auth, cred.address())
  })

  it('signs a CAP-71 V2 auth entry returned by simulation over the address-bound preimage', async () => {
    const auth = await createSponsoredCredentialAuthEntry('addressV2')

    const cred = auth.credentials()
    // The arm must be preserved: downgrading to V1 would produce an entry the
    // network rejects once V2 is mandatory.
    expect(cred.switch().name).toBe('sorobanCredentialsAddressV2')
    expect(Address.fromScAddress(cred.addressV2().address()).toString()).toBe(
      TEST_KEYPAIR.publicKey(),
    )
    expect(cred.addressV2().signatureExpirationLedger()).toBeGreaterThan(50)
    expectSignedByClientOverArmPreimage(auth, cred.addressV2())
  })

  it('does not sign a delegated-credentials auth entry returned by simulation', async () => {
    const auth = await createSponsoredCredentialAuthEntry('addressWithDelegates')

    const cred = auth.credentials()
    expect(cred.switch().name).toBe('sorobanCredentialsAddressWithDelegates')
    // Left exactly as simulation produced it; the server rejects this arm.
    expect(cred.addressWithDelegates().addressCredentials().signature().switch().name).toBe(
      'scvVoid',
    )
  })

  // ── useUpgradedAuth ──────────────────────────────────────────────────────

  it('requests V2 auth entries from simulation when useUpgradedAuth is set', async () => {
    mockPrepareTransaction.mockClear()
    mockSimulateTransaction.mockClear()
    mockGetAccount.mockResolvedValueOnce(new Account(TEST_KEYPAIR.publicKey(), '0'))
    mockSimulateTransaction.mockResolvedValueOnce(mockSimulationWithAuthEntry('addressV2'))
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 50 })

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull', useUpgradedAuth: true })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })
    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    // Simulation is asked for upgraded auth; prepareTransaction (which cannot
    // pass the flag on stellar-sdk 16) is bypassed.
    expect(mockPrepareTransaction).not.toHaveBeenCalled()
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1)
    expect(mockSimulateTransaction.mock.calls[0][3]).toBe(true)

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    const tx = TransactionBuilder.fromXDR(
      decoded.payload.transaction,
      NETWORK_PASSPHRASE[STELLAR_TESTNET],
    ) as Transaction
    const op = tx.operations[0] as Operation.InvokeHostFunction
    expect(tx.source).toBe(ALL_ZEROS)
    expect(tx.signatures.length).toBe(0)
    expect(op.auth?.length).toBe(1)
    const cred = op.auth![0].credentials()
    expect(cred.switch().name).toBe('sorobanCredentialsAddressV2')
    expect(cred.addressV2().signatureExpirationLedger()).toBeGreaterThan(50)
    expectSignedByClientOverArmPreimage(op.auth![0], cred.addressV2())
  })

  it('keeps using prepareTransaction (legacy V1 entries) when useUpgradedAuth is off', async () => {
    mockPrepareTransaction.mockClear()
    mockSimulateTransaction.mockClear()
    const auth = await createSponsoredCredentialAuthEntry('address')

    expect(mockSimulateTransaction).not.toHaveBeenCalled()
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1)
    expect(auth.credentials().switch().name).toBe('sorobanCredentialsAddress')
  })

  it('surfaces a simulation error when useUpgradedAuth is set', async () => {
    mockGetAccount.mockResolvedValueOnce(new Account(TEST_KEYPAIR.publicKey(), '0'))
    mockSimulateTransaction.mockResolvedValueOnce({
      _parsed: true,
      id: 'sim-err',
      latestLedger: 50,
      events: [],
      error: 'HostError: Error(Contract, #10)',
    })

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull', useUpgradedAuth: true })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/Simulation failed: HostError/)
  })

  it('refuses to sign a sponsored auth tree carrying hidden sub-invocations', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const maliciousRoot = transferInvocation(
      USDC_SAC_TESTNET,
      transferArgs(TEST_KEYPAIR.publicKey(), RECIPIENT, 100000n),
      [
        transferInvocation(
          OTHER_TOKEN,
          transferArgs(TEST_KEYPAIR.publicKey(), ATTACKER, 999999999n),
        ),
      ],
    )
    mockPrepareTransaction.mockResolvedValueOnce(
      await buildTxWithAuthInvocation({ source: ALL_ZEROS, rootInvocation: maliciousRoot }),
    )
    mockGetLatestLedger.mockResolvedValueOnce({ sequence: 50 })

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:testnet', feePayer: true },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/sub-invocation/i)
  })

  it('refuses to sign an unsponsored auth tree carrying hidden sub-invocations', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const maliciousRoot = transferInvocation(
      USDC_SAC_TESTNET,
      transferArgs(TEST_KEYPAIR.publicKey(), RECIPIENT, 100000n),
      [
        transferInvocation(
          OTHER_TOKEN,
          transferArgs(TEST_KEYPAIR.publicKey(), ATTACKER, 999999999n),
        ),
      ],
    )
    mockPrepareTransaction.mockResolvedValueOnce(
      await buildTxWithAuthInvocation({
        source: TEST_KEYPAIR.publicKey(),
        rootInvocation: maliciousRoot,
      }),
    )

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge()

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/sub-invocation/i)
  })

  it('refuses to sign when the authorized transfer does not match the requested payment', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    // Root invocation diverts the transfer to the attacker instead of the recipient.
    const divertedRoot = transferInvocation(
      USDC_SAC_TESTNET,
      transferArgs(TEST_KEYPAIR.publicKey(), ATTACKER, 100000n),
    )
    mockPrepareTransaction.mockResolvedValueOnce(
      await buildTxWithAuthInvocation({
        source: TEST_KEYPAIR.publicKey(),
        rootInvocation: divertedRoot,
      }),
    )

    const method = charge({ keypair: TEST_KEYPAIR, mode: 'pull' })
    const challenge = mockChallenge()

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(/does not match the requested payment/i)
  })

  it('uses pubnet DID component for public network', async () => {
    const account = new Account(TEST_KEYPAIR.publicKey(), '0')
    mockGetAccount.mockResolvedValueOnce(account)
    const mockTx = buildMockPreparedTx()
    mockPrepareTransaction.mockResolvedValueOnce(await mockTx)

    const method = charge({ keypair: TEST_KEYPAIR })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:pubnet' },
    })

    const credential = await method.createCredential({
      challenge: challenge as any,
      context: {} as any,
    })

    const token = credential.replace(/^Payment\s+/, '')
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'))
    expect(decoded.source).toMatch(/^did:pkh:stellar:pubnet:G/)
  })
})

// ── DID-PKH ─────────────────────────────────────────────────────────────

describe('DID-PKH format', () => {
  it('constructs correct DID-PKH from network and public key', () => {
    const kp = Keypair.random()
    const network = 'stellar:testnet'
    const source = `did:pkh:${network}:${kp.publicKey()}`

    expect(source).toMatch(/^did:pkh:stellar:testnet:G[A-Z0-9]{55}$/)
  })

  it('uses pubnet component for mainnet', () => {
    const kp = Keypair.random()
    const network = 'stellar:pubnet'
    const source = `did:pkh:${network}:${kp.publicKey()}`

    expect(source).toMatch(/^did:pkh:stellar:pubnet:G[A-Z0-9]{55}$/)
  })
})

describe('network validation', () => {
  it('throws on unsupported network identifier', async () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    const challenge = mockChallenge({
      methodDetails: { network: 'stellar:futurenet' },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Unsupported Stellar network identifier: "stellar:futurenet"')
  })

  it('throws on old-style network shorthand', async () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    const challenge = mockChallenge({
      methodDetails: { network: 'testnet' },
    })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow('Unsupported Stellar network identifier: "testnet"')
  })
})

describe('charge client amount validation', () => {
  it('rejects a counterparty amount exceeding the signed i128 maximum with a typed error', async () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    const challenge = mockChallenge({ amount: (2n ** 127n).toString() })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(StellarMppError)
  })

  it('rejects a malformed counterparty amount with a typed error', async () => {
    const method = charge({ keypair: TEST_KEYPAIR })
    const challenge = mockChallenge({ amount: '100abc' })

    await expect(
      method.createCredential({ challenge: challenge as any, context: {} as any }),
    ).rejects.toThrow(StellarMppError)
  })
})
