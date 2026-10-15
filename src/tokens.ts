import { createHash, randomBytes } from 'node:crypto'

export function generateToken(length = 40): string {
  return randomBytes(length).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isTokenShaped(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(value)) return false
  return Buffer.from(value, 'base64url').toString('base64url') === value
}
