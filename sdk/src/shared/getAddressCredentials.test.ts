import { Address, Keypair, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { getAddressCredentials } from './getAddressCredentials.js'

function addressCredentials(): xdr.SorobanAddressCredentials {
  return new xdr.SorobanAddressCredentials({
    address: new Address(Keypair.random().publicKey()).toScAddress(),
    nonce: new xdr.Int64(7),
    signatureExpirationLedger: 1000,
    signature: xdr.ScVal.scvVec([]),
  })
}

describe('getAddressCredentials', () => {
  it('unwraps the legacy V1 address arm', () => {
    const inner = addressCredentials()
    const creds = xdr.SorobanCredentials.sorobanCredentialsAddress(inner)

    expect(getAddressCredentials(creds)).toBe(inner)
  })

  it('unwraps the CAP-71 V2 address arm', () => {
    const inner = addressCredentials()
    const creds = xdr.SorobanCredentials.sorobanCredentialsAddressV2(inner)

    expect(getAddressCredentials(creds)).toBe(inner)
  })

  it('returns undefined for source-account credentials', () => {
    expect(getAddressCredentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount())).toBe(
      undefined,
    )
  })

  it('returns undefined for delegated credentials, even though they wrap address credentials', () => {
    const creds = xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
      new xdr.SorobanAddressCredentialsWithDelegates({
        addressCredentials: addressCredentials(),
        delegates: [],
      }),
    )

    expect(getAddressCredentials(creds)).toBe(undefined)
  })
})
