import { describe, expect, it, vi } from 'vitest'
import { NETWORK_PASSPHRASE, STELLAR_PUBNET, STELLAR_TESTNET } from '../constants.js'
import { StellarMppError } from './errors.js'
import { assertRpcServesNetwork } from './rpc-network.js'
import { TimeoutError } from './timeout.js'

function stubServer(passphrase: string) {
  return {
    getNetwork: vi.fn().mockResolvedValue({
      passphrase,
      protocolVersion: '22',
    }),
  }
}

// Each test uses its own URL: a confirmed endpoint is remembered for the
// lifetime of the process, so a shared URL would leak state between tests.
describe('assertRpcServesNetwork', () => {
  it('resolves when the endpoint serves the expected network', async () => {
    const server = stubServer(NETWORK_PASSPHRASE[STELLAR_TESTNET])

    await expect(
      assertRpcServesNetwork(server, 'https://match.example.com', STELLAR_TESTNET),
    ).resolves.toBeUndefined()
    expect(server.getNetwork).toHaveBeenCalledTimes(1)
  })

  it('rejects when the endpoint serves a different network', async () => {
    const server = stubServer(NETWORK_PASSPHRASE[STELLAR_PUBNET])

    await expect(
      assertRpcServesNetwork(server, 'https://mismatch.example.com', STELLAR_TESTNET),
    ).rejects.toThrow(StellarMppError)
    await expect(
      assertRpcServesNetwork(server, 'https://mismatch.example.com', STELLAR_TESTNET),
    ).rejects.toThrow('does not serve "stellar:testnet"')

    // Only a confirmed endpoint is remembered, so the second call asks again.
    expect(server.getNetwork).toHaveBeenCalledTimes(2)
  })

  it('keeps the endpoint URL out of the error, which may carry an API key', async () => {
    const server = stubServer(NETWORK_PASSPHRASE[STELLAR_TESTNET])
    const rpcUrl = 'https://rpc.example.com/?apiKey=super-secret'

    await expect(assertRpcServesNetwork(server, rpcUrl, STELLAR_PUBNET)).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('super-secret'),
      }),
    )
  })

  it('does not re-query an endpoint already confirmed for that network', async () => {
    const server = stubServer(NETWORK_PASSPHRASE[STELLAR_TESTNET])
    const rpcUrl = 'https://cached.example.com'

    await assertRpcServesNetwork(server, rpcUrl, STELLAR_TESTNET)
    await assertRpcServesNetwork(server, rpcUrl, STELLAR_TESTNET)

    expect(server.getNetwork).toHaveBeenCalledTimes(1)
  })

  it('re-queries a confirmed endpoint when a different network is expected', async () => {
    const server = stubServer(NETWORK_PASSPHRASE[STELLAR_TESTNET])
    const rpcUrl = 'https://revisited.example.com'

    await assertRpcServesNetwork(server, rpcUrl, STELLAR_TESTNET)
    await expect(assertRpcServesNetwork(server, rpcUrl, STELLAR_PUBNET)).rejects.toThrow(
      StellarMppError,
    )

    expect(server.getNetwork).toHaveBeenCalledTimes(2)
  })

  it('wraps a transport failure in a typed error', async () => {
    const server = { getNetwork: vi.fn().mockRejectedValue(new Error('socket hang up')) }

    await expect(
      assertRpcServesNetwork(server, 'https://down.example.com', STELLAR_TESTNET),
    ).rejects.toThrow(StellarMppError)
    await expect(
      assertRpcServesNetwork(server, 'https://down.example.com', STELLAR_TESTNET),
    ).rejects.toThrow('did not identify its network')
  })

  it('fails with a timeout rather than hanging on an unresponsive endpoint', async () => {
    const server = { getNetwork: vi.fn().mockReturnValue(new Promise(() => {})) }

    await expect(
      assertRpcServesNetwork(server, 'https://hangs.example.com', STELLAR_TESTNET, 10),
    ).rejects.toThrow(TimeoutError)
  })
})
