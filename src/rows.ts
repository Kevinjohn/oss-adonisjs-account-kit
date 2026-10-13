import { DateTime } from 'luxon'
import type { Invitation, UserId } from './types.js'

type DatabaseDate = Date | string

interface InvitationDatabaseRow {
  id: number
  email: string
  role: string
  inviter_id: UserId | null
  token_hash: string
  expires_at: DatabaseDate
  created_at: DatabaseDate
  updated_at: DatabaseDate
}

interface RecoveryDatabaseRow {
  id: number
  user_id: UserId
  email: string
  token_hash: string
  expires_at: DatabaseDate
  created_at: DatabaseDate
}

interface EmailChangeDatabaseRow {
  id: number
  user_id: UserId
  current_email: string
  new_email: string
  token_hash: string
  expires_at: DatabaseDate
  created_at: DatabaseDate
}

export interface RecoveryRow {
  id: number
  userId: UserId
  email: string
  tokenHash: string
  expiresAt: DateTime
  createdAt: DateTime
}

export interface EmailChangeRow {
  id: number
  userId: UserId
  currentEmail: string
  newEmail: string
  tokenHash: string
  expiresAt: DateTime
  createdAt: DateTime
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

export function toRecoveryRow(row: RecoveryDatabaseRow): RecoveryRow {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    tokenHash: row.token_hash,
    expiresAt: toDateTime(row.expires_at),
    createdAt: toDateTime(row.created_at),
  }
}

export function toEmailChangeRow(row: EmailChangeDatabaseRow): EmailChangeRow {
  return {
    id: row.id,
    userId: row.user_id,
    currentEmail: row.current_email,
    newEmail: row.new_email,
    tokenHash: row.token_hash,
    expiresAt: toDateTime(row.expires_at),
    createdAt: toDateTime(row.created_at),
  }
}
