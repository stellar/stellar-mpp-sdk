import { Address, Keypair, StrKey, hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import { StellarMppError } from './errors.js'

/**
 * Verifies the ed25519 signature(s) carried by a Soroban authorization entry's
 * address credentials against the canonical authorization payload.
 *
 * Soroban RPC simulation runs in recording mode and never checks these
 * signatures, so a server that broadcasts a counterparty-supplied transaction
 * without this check would settle one carrying a correctly-shaped but invalidly
 * signed entry — the transaction then fails `require_auth` at apply time and the
 * fee the server paid to broadcast it is wasted. This reconstructs the same
 * preimage `authorizeEntry` signs and the network validates, so an entry that
 * passes here will not be rejected on-chain for a bad authorization signature.
 *
 * Only stellar-account (ed25519) authorizers are supported, matching the
 * credentials the charge client emits. Source-account and contract (custom
 * `__check_auth`) authorizers cannot be verified off-chain and are rejected.
 *
 * @throws {StellarMppError} If the entry is not address-signed by a stellar
 *   account, the signature payload is malformed, the signer is not the
 *   authorizing account, or any signature fails to verify.
 */
export function verifyAuthEntrySignature(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): void {
  const credentials = entry.credentials()
  if (credentials.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
    throw new StellarMppError('Auth entry must use address credentials to verify its signature.', {
      credentialType: credentials.switch().name,
    })
  }

  const addressCred = credentials.address()

  const authorizer = addressCred.address()
  if (authorizer.switch().value !== xdr.ScAddressType.scAddressTypeAccount().value) {
    throw new StellarMppError(
      'Auth entry authorizer must be a stellar account; contract authorizers cannot be verified off-chain.',
      { addressType: authorizer.switch().name },
    )
  }
  const authorizerPublicKey = Address.fromScAddress(authorizer).toString()

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: addressCred.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: addressCred.signatureExpirationLedger(),
    }),
  )
  const payload = hash(preimage.toXDR())

  const signatures = parseAccountSignatures(addressCred.signature())
  if (signatures.length === 0) {
    throw new StellarMppError('Auth entry carries no signatures.')
  }

  for (const { publicKey, signature } of signatures) {
    if (publicKey !== authorizerPublicKey) {
      throw new StellarMppError(
        'Auth entry signature was produced by a key other than the authorizing account.',
        { authorizer: authorizerPublicKey, signer: publicKey },
      )
    }
    if (!Keypair.fromPublicKey(publicKey).verify(payload, signature)) {
      throw new StellarMppError('Auth entry signature does not match the authorization payload.', {
        authorizer: authorizerPublicKey,
      })
    }
  }
}

/**
 * Decodes the `Vec<{public_key, signature}>` account-signature structure that
 * `authorizeEntry` writes into an address credential's signature field. Any
 * deviation from that shape is rejected rather than silently skipped, so a
 * malformed signature can never bypass verification.
 */
function parseAccountSignatures(
  signature: xdr.ScVal,
): Array<{ publicKey: string; signature: Buffer }> {
  // A Soroban account authorizer is satisfied by a single signature; on-chain
  // require_auth gains nothing from extras. Reject a longer vector on the raw
  // ScVal, before decoding and verifying, so a padded vector cannot amplify the
  // per-element verification work below.
  const rawEntries =
    signature.switch().value === xdr.ScValType.scvVec().value ? signature.vec() : null
  if (rawEntries && rawEntries.length > 1) {
    throw new StellarMppError('Auth entry must carry a single account signature.', {
      count: rawEntries.length,
    })
  }

  let decoded: unknown
  try {
    decoded = scValToNative(signature)
  } catch (error) {
    throw new StellarMppError('Auth entry signature is not valid Soroban data.', {
      details: error instanceof Error ? error.message : String(error),
    })
  }

  if (!Array.isArray(decoded)) {
    throw new StellarMppError('Auth entry signature must be a vector of account signatures.')
  }

  return decoded.map((sig) => {
    if (
      typeof sig !== 'object' ||
      sig === null ||
      !('public_key' in sig) ||
      !('signature' in sig)
    ) {
      throw new StellarMppError(
        'Auth entry signature entry must contain a public_key and a signature.',
      )
    }
    const { public_key: publicKeyBytes, signature: signatureBytes } = sig as {
      public_key: unknown
      signature: unknown
    }
    if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length !== 32) {
      throw new StellarMppError('Auth entry signature has an invalid public key.')
    }
    if (!(signatureBytes instanceof Uint8Array) || signatureBytes.length !== 64) {
      throw new StellarMppError('Auth entry signature has an invalid signature length.')
    }
    return {
      publicKey: StrKey.encodeEd25519PublicKey(Buffer.from(publicKeyBytes)),
      signature: Buffer.from(signatureBytes),
    }
  })
}
