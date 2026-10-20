// Encodes and decodes the opaque cursor for paging through admission records.
import { DateTime } from 'luxon'
import { InvalidInputError } from '../errors.js'

const MAX_ADMISSION_CURSOR_LENGTH = 512

export type AdmissionCursor = { createdAt: string; id: number }

/** The cursor for the page after the row with this `created_at` and `id`. */
export function encodeAdmissionCursor(createdAt: unknown, id: unknown): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
}

/** Reads a cursor from `encodeAdmissionCursor`; anything else is `InvalidInputError`. */
export function decodeAdmissionCursor(cursor: string): AdmissionCursor {
  try {
    if (typeof cursor !== 'string' || cursor.length > MAX_ADMISSION_CURSOR_LENGTH)
      throw new Error('invalid')
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== 'string' ||
      !DateTime.fromISO(decoded[0], { setZone: true }).isValid ||
      !Number.isSafeInteger(decoded[1]) ||
      decoded[1] < 1 ||
      Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor
    )
      throw new Error('invalid')
    return { createdAt: decoded[0], id: decoded[1] }
  } catch {
    throw new InvalidInputError('Invalid admission cursor')
  }
}
