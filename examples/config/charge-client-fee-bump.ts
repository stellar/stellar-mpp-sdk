import { parseNetworkId, parseOptional, parseStellarSecretKey } from '../../sdk/src/env.js'
import type { NetworkId } from '../../sdk/src/constants.js'

export class Env {
  static get stellarSecret(): string {
    return parseStellarSecretKey('STELLAR_SECRET')
  }

  static get network(): NetworkId {
    return parseNetworkId()
  }

  static get feeBumpSecret(): string {
    return parseStellarSecretKey('FEE_BUMP_SECRET')
  }

  static get serverUrl(): string {
    return parseOptional('SERVER_URL', 'http://localhost:3000')!
  }

  static get chargeClientMode(): 'push' | 'pull' {
    const mode = parseOptional('CHARGE_CLIENT_MODE', 'pull')!
    if (mode !== 'push' && mode !== 'pull') {
      throw new Error(`CHARGE_CLIENT_MODE must be 'push' or 'pull', got: ${mode}`)
    }
    return mode as 'push' | 'pull'
  }
}
