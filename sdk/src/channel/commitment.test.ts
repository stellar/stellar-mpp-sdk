import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { STELLAR_PUBNET, STELLAR_TESTNET } from '../constants.js'
import { assertCommitmentBinds } from './commitment.js'

const CHANNEL = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526'
const OTHER_CHANNEL = 'CAYGVE5AUQQ2XNXWOXHH5VPGRHYX4APUAOWA4VOBI3VGMOYJ2IJ6VJG5'

/**
 * Builds commitment bytes exactly as the one-way-channel contract's
 * `prepare_commitment` does: the XDR of an `ScVal::Map` with four
 * alphabetically-sorted entries (amount, channel, domain, network).
 */
function buildCommitmentBytes(opts: {
  channel?: string
  amount?: bigint
  networkPassphrase?: string
  domain?: string
}): Buffer {
  const {
    channel = CHANNEL,
    amount = 1_000_000n,
    networkPassphrase = Networks.TESTNET,
    domain = 'chancmmt',
  } = opts
  const networkId = hash(Buffer.from(networkPassphrase))
  const map = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal('amount', { type: 'symbol' }),
      val: nativeToScVal(amount, { type: 'i128' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('channel', { type: 'symbol' }),
      val: new Address(channel).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('domain', { type: 'symbol' }),
      val: nativeToScVal(domain, { type: 'symbol' }),
    }),
    new xdr.ScMapEntry({
      key: nativeToScVal('network', { type: 'symbol' }),
      val: xdr.ScVal.scvBytes(networkId),
    }),
  ])
  return map.toXDR()
}

describe('assertCommitmentBinds', () => {
  it('accepts a commitment that binds to the intended channel, amount and network', () => {
    const bytes = buildCommitmentBytes({ channel: CHANNEL, amount: 1_000_000n })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).not.toThrow()
  })

  it('rejects a commitment encoding a different amount than intended', () => {
    const bytes = buildCommitmentBytes({ channel: CHANNEL, amount: 999_999_999n })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/amount mismatch/i)
  })

  it('rejects a commitment encoding a different channel than the pinned one', () => {
    const bytes = buildCommitmentBytes({ channel: OTHER_CHANNEL, amount: 1_000_000n })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/channel mismatch/i)
  })

  it('rejects a commitment with a forged domain separator', () => {
    const bytes = buildCommitmentBytes({ channel: CHANNEL, amount: 1_000_000n, domain: 'evilcmmt' })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/domain mismatch/i)
  })

  it('rejects a commitment serialized for a different network', () => {
    const bytes = buildCommitmentBytes({
      channel: CHANNEL,
      amount: 1_000_000n,
      networkPassphrase: Networks.PUBLIC,
    })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/network mismatch/i)
  })

  it('accepts a pubnet commitment when pubnet is the intended network', () => {
    const bytes = buildCommitmentBytes({
      channel: CHANNEL,
      amount: 1_000_000n,
      networkPassphrase: Networks.PUBLIC,
    })

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_PUBNET,
      }),
    ).not.toThrow()
  })

  it('rejects bytes that do not decode to a commitment struct', () => {
    const bytes = Buffer.from('not-a-valid-xdr-commitment')

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/commitment/i)
  })
})
