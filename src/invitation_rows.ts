import type { DateTime } from 'luxon'
import type { Invitation, UserId } from './types.ts'
import { readTimestamp } from './timestamps.ts'
import { decodeScopeColumn } from './invitation_scope.ts'

type DatabaseDate = Date | string

export interface InvitationDatabaseRow {
  id: number
  email: string
  role: string
  scope: string
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
    scope: decodeScopeColumn(row.scope),
    inviterId: row.inviter_id,
    expiresAt: toDateTime(row.expires_at),
    createdAt: toDateTime(row.created_at),
    updatedAt: toDateTime(row.updated_at),
  }
}
