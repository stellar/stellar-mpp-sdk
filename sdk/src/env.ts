import { StrKey } from '@stellar/stellar-sdk'
import { STELLAR_TESTNET, type NetworkId } from './constants.js'
import { resolveNetworkId } from './shared/validation.js'

export function parseRequired(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`)
  }
  return value
}

export function parseOptional(name: string, fallback?: string): string | undefined {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  return fallback
}

export function parsePort(name: string = 'PORT', fallback?: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is required`)
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw}. Must be an integer between 1 and 65535.`)
  }
  return port
}

export function parseStellarPublicKey(name: string): string {
  const value = parseRequired(name)
  if (!StrKey.isValidEd25519PublicKey(value)) {
    throw new Error(`${name} must be a valid Stellar public key (G...)`)
  }
  return value
}

export function parseStellarSecretKey(name: string): string {
  const value = parseRequired(name)
  if (!StrKey.isValidEd25519SecretSeed(value)) {
    throw new Error(`${name} must be a valid Stellar secret key (S...)`)
  }
  return value
}

export function parseContractAddress(name: string): string {
  const value = parseRequired(name)
  if (!StrKey.isValidContract(value)) {
    throw new Error(`${name} must be a valid contract address (C...)`)
  }
  return value
}

/** Parses a CAIP-2 Stellar network identifier, defaulting to testnet. */
export function parseNetworkId(name: string = 'STELLAR_NETWORK'): NetworkId {
  return resolveNetworkId(parseOptional(name, STELLAR_TESTNET))
}

export function parseHexKey(name: string, length: number = 64): string {
  const value = parseRequired(name)
  const hexRegex = new RegExp(`^[0-9a-fA-F]{${length}}$`)
  if (!hexRegex.test(value)) {
    throw new Error(`${name} must be ${length} hex characters`)
  }
  return value
}

export function parseCommaSeparatedList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseNumber(
  name: string,
  opts?: { min?: number; max?: number; fallback?: number },
): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') {
    if (opts?.fallback !== undefined) return opts.fallback
    throw new Error(`${name} is required`)
  }
  const num = Number(raw)
  if (isNaN(num)) {
    throw new Error(`Invalid ${name}: ${raw}. Must be a number.`)
  }
  if (opts?.min !== undefined && num < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}`)
  }
  if (opts?.max !== undefined && num > opts.max) {
    throw new Error(`${name} must be <= ${opts.max}`)
  }
  return num
}
