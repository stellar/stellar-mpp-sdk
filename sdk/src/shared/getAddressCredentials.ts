import { xdr } from '@stellar/stellar-sdk'

/**
 * Returns the address credentials carried by a Soroban credential union, for
 * both the legacy V1 `sorobanCredentialsAddress` arm and the CAP-71 V2
 * `sorobanCredentialsAddressV2` arm, which networks accept from Protocol 28
 * onward. Both arms wrap the same `SorobanAddressCredentials` structure and
 * differ only in the preimage the signer commits to. Returns `undefined` for
 * every other arm (source-account, delegated).
 *
 * This is deliberately stricter than the stellar-sdk's internal helper of the
 * same name, which also unwraps `sorobanCredentialsAddressWithDelegates`. A
 * delegated entry is authorized by keys other than the address it names, so the
 * charge verifier must reject it rather than treat it as a plain address entry.
 * (The SDK helper is also not exported from the package root as of 16.x.)
 *
 * @param credentials - The credential union from an auth entry
 * @returns The address credentials, or undefined for non-address arms
 */
export function getAddressCredentials(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | undefined {
  switch (credentials.switch().value) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress().value:
      return credentials.address()
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2().value:
      return credentials.addressV2()
    default:
      return undefined
  }
}
