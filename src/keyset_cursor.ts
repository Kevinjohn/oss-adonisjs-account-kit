// Encodes and decodes the opaque `[createdAt, id]` cursor for paging admission and invitation listings.
import { DateTime } from 'luxon'
import { E_ACCOUNT_KIT_INVALID_INPUT } from './errors.js'

const MAX_KEYSET_CURSOR_LENGTH = 512

export type KeysetCursor = { createdAt: string; id: number }

/** The cursor for the page after the row with this `created_at` and `id`. */
export function encodeKeysetCursor(createdAt: unknown, id: unknown): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
}

/** Reads a cursor from `encodeKeysetCursor`; anything else is `E_ACCOUNT_KIT_INVALID_INPUT` with `message`. */
export function decodeKeysetCursor(cursor: string, message: string): KeysetCursor {
  if (typeof cursor !== 'string' || cursor.length > MAX_KEYSET_CURSOR_LENGTH)
    throw new E_ACCOUNT_KIT_INVALID_INPUT(message)

  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new E_ACCOUNT_KIT_INVALID_INPUT(message)
  }

  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== 'string' ||
    !DateTime.fromISO(decoded[0], { setZone: true }).isValid ||
    !Number.isSafeInteger(decoded[1]) ||
    decoded[1] < 1 ||
    Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor
  )
    throw new E_ACCOUNT_KIT_INVALID_INPUT(message)
  return { createdAt: decoded[0], id: decoded[1] }
}
