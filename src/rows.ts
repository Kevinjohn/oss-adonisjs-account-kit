import { DateTime } from 'luxon'
import type { Invitation, UserId } from './types.js'

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
  const dateTime =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: 'utc' })
      : DateTime.fromISO(value, { zone: 'utc' })
  return dateTime.toUTC()
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
