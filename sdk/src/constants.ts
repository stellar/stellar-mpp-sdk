import { Networks } from '@stellar/stellar-sdk'

// ---------------------------------------------------------------------------
// Networks (CAIP-2 identifiers)
// ---------------------------------------------------------------------------

/** Stellar testnet CAIP-2 chain identifier. */
export const STELLAR_TESTNET = 'stellar:testnet' as const

/** Stellar mainnet (pubnet) CAIP-2 chain identifier. */
export const STELLAR_PUBNET = 'stellar:pubnet' as const

export const NETWORK_PASSPHRASE = {
  [STELLAR_PUBNET]: Networks.PUBLIC,
  [STELLAR_TESTNET]: Networks.TESTNET,
} as const

export type NetworkId = keyof typeof NETWORK_PASSPHRASE

// ---------------------------------------------------------------------------
// RPC / Horizon URLs
// ---------------------------------------------------------------------------

export const SOROBAN_RPC_URLS: Record<NetworkId, string> = {
  [STELLAR_PUBNET]: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
  [STELLAR_TESTNET]: 'https://soroban-testnet.stellar.org',
}

export const HORIZON_URLS: Record<NetworkId, string> = {
  [STELLAR_PUBNET]: 'https://horizon.stellar.org',
  [STELLAR_TESTNET]: 'https://horizon-testnet.stellar.org',
}

// ---------------------------------------------------------------------------
// Well-known SEP-41 token contract addresses (Stellar Asset Contract / SAC implementations)
// ---------------------------------------------------------------------------

/** USDC SEP-41 token contract address on Stellar mainnet (SAC). */
export const USDC_SAC_MAINNET = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

/** USDC SEP-41 token contract address on Stellar testnet (SAC). */
export const USDC_SAC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

/** Native XLM SEP-41 token contract address on mainnet (SAC). */
export const XLM_SAC_MAINNET = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'

/** Native XLM SEP-41 token contract address on testnet (SAC). */
export const XLM_SAC_TESTNET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

/** Map from network to well-known SEP-41 token addresses (SAC) for USDC and XLM. */
export const SAC_ADDRESSES = {
  [STELLAR_PUBNET]: {
    USDC: USDC_SAC_MAINNET,
    XLM: XLM_SAC_MAINNET,
  },
  [STELLAR_TESTNET]: {
    USDC: USDC_SAC_TESTNET,
    XLM: XLM_SAC_TESTNET,
  },
} as const

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default number of decimal places for Stellar assets. */
export const DEFAULT_DECIMALS = 7

/** Default fee in stroops. */
export const DEFAULT_FEE = '100'

/** Default transaction timeout in seconds. */
export const DEFAULT_TIMEOUT = 180

/** Average Stellar ledger close time in seconds. */
export const DEFAULT_LEDGER_CLOSE_TIME = 5

/** Default challenge expiry in seconds (5 minutes). */
export const DEFAULT_CHALLENGE_EXPIRY = 300

// ---------------------------------------------------------------------------
// Special accounts
// ---------------------------------------------------------------------------

/**
 * All-zeros Stellar source account (`GAAA...WHF`).
 *
 * Used in the spec-compliant sponsored charge flow: the client sets this as
 * the transaction source so the server can substitute its own fee-payer
 * account when rebuilding the transaction.
 */
export const ALL_ZEROS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
