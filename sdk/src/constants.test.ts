import { Asset, Networks, StrKey } from '@stellar/stellar-sdk'
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

  // A malformed literal here is not a cosmetic problem: every entry is exported
  // as public API and fed straight to `new Contract(...)`, so a bad address
  // surfaces as an opaque failure inside the SDK rather than at the call site.
  it('exports SAC_ADDRESSES entries that are all valid contract addresses', () => {
    for (const [network, tokens] of Object.entries(constants.SAC_ADDRESSES)) {
      for (const [symbol, address] of Object.entries(tokens)) {
        expect(StrKey.isValidContract(address), `${network} ${symbol} (${address})`).toBe(true)
      }
    }
  })

  // Stronger than the shape check above: a SAC address is derived from the
  // asset and the network, so the expected value can be recomputed rather than
  // trusted. This catches a wrong-but-well-formed address, which validation
  // alone cannot.
  it('exports SAC addresses that match the ones derived from the asset', () => {
    // Circulating USDC issuers, which are what make the derivations reproducible.
    const usdcMainnetIssuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    const usdcTestnetIssuer = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

    expect(constants.XLM_SAC_MAINNET).toBe(Asset.native().contractId(Networks.PUBLIC))
    expect(constants.XLM_SAC_TESTNET).toBe(Asset.native().contractId(Networks.TESTNET))
    expect(constants.USDC_SAC_MAINNET).toBe(
      new Asset('USDC', usdcMainnetIssuer).contractId(Networks.PUBLIC),
    )
    expect(constants.USDC_SAC_TESTNET).toBe(
      new Asset('USDC', usdcTestnetIssuer).contractId(Networks.TESTNET),
    )
  })

  it('exports DEFAULT_DECIMALS as 7', () => {
    expect(constants.DEFAULT_DECIMALS).toBe(7)
  })
})
