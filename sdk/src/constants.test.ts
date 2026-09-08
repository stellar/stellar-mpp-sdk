import { Asset, Networks, StrKey } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import * as constants from './constants.js'

const { STELLAR_PUBNET, STELLAR_TESTNET } = constants

// Circle's USDC issuing accounts. The SAC address for an asset is fully
// determined by (asset, network passphrase), so deriving it here keeps the
// hardcoded constants honest — a truncated or mistyped C-address fails this
// suite instead of shipping. Asserting them against copies of the same string
// literals, as this file used to, only re-encoded whatever was already wrong.
const USDC_ISSUER_MAINNET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC_ISSUER_TESTNET = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

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

  it('derives USDC SAC contract addresses from the Circle issuers', () => {
    expect(constants.USDC_SAC_MAINNET).toBe(
      new Asset('USDC', USDC_ISSUER_MAINNET).contractId(Networks.PUBLIC),
    )
    expect(constants.USDC_SAC_TESTNET).toBe(
      new Asset('USDC', USDC_ISSUER_TESTNET).contractId(Networks.TESTNET),
    )
  })

  it('derives XLM SAC contract addresses from the native asset', () => {
    expect(constants.XLM_SAC_MAINNET).toBe(Asset.native().contractId(Networks.PUBLIC))
    expect(constants.XLM_SAC_TESTNET).toBe(Asset.native().contractId(Networks.TESTNET))
  })

  it('exports only well-formed contract StrKeys in SAC_ADDRESSES', () => {
    const addresses = Object.values(constants.SAC_ADDRESSES).flatMap((byAsset): string[] =>
      Object.values(byAsset),
    )

    expect(addresses.length).toBeGreaterThan(0)
    for (const address of addresses) {
      expect(StrKey.isValidContract(address), `${address} is not a valid contract StrKey`).toBe(
        true,
      )
    }
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
