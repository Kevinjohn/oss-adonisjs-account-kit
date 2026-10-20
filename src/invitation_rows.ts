import type { DateTime } from 'luxon'
import type { Invitation, UserId } from './types.js'
import { readTimestamp } from './timestamps.js'

type DatabaseDate = Date | string

export interface InvitationDatabaseRow {
  id: number
  email: string
  role: string
  inviter_id: UserId | null
  token_hash: string
  expires_at: DatabaseDate
  created_at: DatabaseDate
  updated_at: DatabaseDate
}

function toDateTime(value: DatabaseDate): DateTime {
  return readTimestamp(value)!.toUTC()
}

export function toInvitation(row: InvitationDatabaseRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    inviterId: row.inviter_id,
    expiresAt: toDateTime(row.expires_at),
    createdAt: toDateTime(row.created_at),
    updatedAt: toDateTime(row.updated_at),
  }
}
