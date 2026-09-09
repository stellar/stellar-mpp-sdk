import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { describe, expect, it } from 'vitest'
import { STELLAR_PUBNET, STELLAR_TESTNET } from '../constants.js'
import { assertCommitmentBinds, buildCommitmentMessage } from './commitment.js'

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

describe('buildCommitmentMessage', () => {
  // Captured from a real one-way-channel contract deployed on testnet:
  //   stellar contract invoke --id CAGQ...TSST --network testnet \
  //     -- prepare_commitment --amount 1000000
  // Pins the encoding against the contract as of channel.wasm 908a23fd…2326.
  // The live parity test re-derives this against a fresh deploy; this one keeps
  // the guarantee under `make check`, where there is no network.
  const ON_CHAIN_CHANNEL = 'CAGQNIIZVSURKZL57HYJV2FQG77HJR2FZMJIX6ZLTAUINKHH26GYTSST'
  // prettier-ignore
  const ON_CHAIN_BYTES_HEX =
    '0000001100000001000000040000000f00000006616d6f756e7400000000000a000000000000000000000000000f42400000000f000000076368616e6e656c0000000012000000010d06a119aca915657df9f09ae8b037fe74c745cb128bfb2b982886a8e7d78d890000000f00000006646f6d61696e00000000000f000000086368616e636d6d740000000f000000076e6574776f726b000000000d00000020cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472'

  it('matches bytes returned by the contract on testnet', () => {
    const local = buildCommitmentMessage({
      channel: ON_CHAIN_CHANNEL,
      amount: 1_000_000n,
      network: STELLAR_TESTNET,
    })

    expect(local.toString('hex')).toBe(ON_CHAIN_BYTES_HEX)
  })

  it('round-trips through assertCommitmentBinds', () => {
    // The encoder and the decoder are independent implementations, so agreeing
    // on every field is a meaningful cross-check.
    for (const network of [STELLAR_TESTNET, STELLAR_PUBNET] as const) {
      for (const amount of [1n, 1_000_000n, 2n ** 100n]) {
        const bytes = buildCommitmentMessage({ channel: CHANNEL, amount, network })
        expect(() =>
          assertCommitmentBinds(bytes, { channel: CHANNEL, amount, network }),
        ).not.toThrow()
      }
    }
  })

  it('binds the commitment to its channel, amount and network', () => {
    const bytes = buildCommitmentMessage({
      channel: CHANNEL,
      amount: 1_000_000n,
      network: STELLAR_TESTNET,
    })

    // A signature over these bytes must not be reusable on another channel,
    // for another amount, or on another network.
    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: OTHER_CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/channel mismatch/i)

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 999_999n,
        network: STELLAR_TESTNET,
      }),
    ).toThrow(/amount mismatch/i)

    expect(() =>
      assertCommitmentBinds(bytes, {
        channel: CHANNEL,
        amount: 1_000_000n,
        network: STELLAR_PUBNET,
      }),
    ).toThrow(/network mismatch/i)
  })
})
