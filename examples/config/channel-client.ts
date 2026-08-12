import {
  parseContractAddress,
  parseHexKey,
  parseNetworkId,
  parseOptional,
} from '../../sdk/src/env.js'
import type { NetworkId } from '../../sdk/src/constants.js'

export class Env {
  static get commitmentSecret(): string {
    return parseHexKey('COMMITMENT_SECRET')
  }

  static get network(): NetworkId {
    return parseNetworkId()
  }

  static get serverUrl(): string {
    return parseOptional('SERVER_URL', 'http://localhost:3001')!
  }

  static get channelContract(): string {
    return parseContractAddress('CHANNEL_CONTRACT')
  }
}
