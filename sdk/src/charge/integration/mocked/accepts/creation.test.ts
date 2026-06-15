import { Keypair } from '@stellar/stellar-sdk'
import { Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { USDC_SAC_TESTNET } from '../../../../constants.js'
import { charge as serverCharge } from '../../../server/Charge.js'

// Happy-path integration test: charge server construction succeeds (accepts).

const RECIPIENT = Keypair.random().publicKey()

describe('charge server creation', () => {
  it('creates method with defaults', () => {
    const method = serverCharge({
      recipient: RECIPIENT,
      currency: USDC_SAC_TESTNET,
      store: Store.memory(),
    })
    expect(method.name).toBe('stellar')
    expect(method.intent).toBe('charge')
    expect(typeof method.verify).toBe('function')
  })
})
