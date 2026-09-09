import { describe, expect, it } from 'vitest'
import * as constants from './constants.js'

const { STELLAR_PUBNET, STELLAR_TESTNET } = constants

describe('constants', () => {
  it('exports NETWORK_PASSPHRASE for pubnet and testnet', () => {
    expect(constants.NETWORK_PASSPHRASE[STELLAR_PUBNET]).toBe(
      'Public Global Stellar Network ; September 2015',
    )
    expect(constants.NETWORK_PASSPHRASE[STELLAR_TESTNET]).toBe('Test SDF Network ; September 2015')
  })

  it('exports SOROBAN_RPC_URLS', () => {
    expect(constants.SOROBAN_RPC_URLS[STELLAR_PUBNET]).toBe(
      'https://soroban-rpc.mainnet.stellar.gateway.fm',
    )
    expect(constants.SOROBAN_RPC_URLS[STELLAR_TESTNET]).toBe('https://soroban-testnet.stellar.org')
  })

  it('exports HORIZON_URLS', () => {
    expect(constants.HORIZON_URLS[STELLAR_PUBNET]).toBe('https://horizon.stellar.org')
    expect(constants.HORIZON_URLS[STELLAR_TESTNET]).toBe('https://horizon-testnet.stellar.org')
  })

  it('exports USDC SAC contract addresses', () => {
    expect(constants.USDC_SAC_MAINNET).toBe(
      'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    )
    expect(constants.USDC_SAC_TESTNET).toBe(
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    )
  })

  it('exports XLM SAC contract addresses', () => {
    expect(constants.XLM_SAC_MAINNET).toBe(
      'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    )
    expect(constants.XLM_SAC_TESTNET).toBe(
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    )
  })

  it('exports SAC_ADDRESSES map', () => {
    expect(constants.SAC_ADDRESSES[STELLAR_PUBNET].USDC).toBe(constants.USDC_SAC_MAINNET)
    expect(constants.SAC_ADDRESSES[STELLAR_TESTNET].USDC).toBe(constants.USDC_SAC_TESTNET)
    expect(constants.SAC_ADDRESSES[STELLAR_PUBNET].XLM).toBe(constants.XLM_SAC_MAINNET)
    expect(constants.SAC_ADDRESSES[STELLAR_TESTNET].XLM).toBe(constants.XLM_SAC_TESTNET)
  })

  it('exports DEFAULT_DECIMALS as 7', () => {
    expect(constants.DEFAULT_DECIMALS).toBe(7)
  })
})
