import { createHash, randomBytes } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import type User from '#models/user'

export type ProofFamily = 'reset-password' | 'verify-email' | 'confirm-email'

/** Create a proof row for an account fixture; each browser journey owns its user. */
export async function createProofFor(user: User, family: ProofFamily, expired = false) {
  const token = randomBytes(40).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  const table = family === 'reset-password' ? 'password_reset_tokens' : 'email_verification_tokens'
  const now = new Date()
  await db.table(table).insert({
    tokenable_id: user.id,
    email: family === 'confirm-email' ? 'changed@example.test' : user.email,
    ...(family === 'reset-password'
      ? {}
      : {
          current_email: user.email,
          purpose: family === 'confirm-email' ? 'email_change' : 'activation',
        }),
    hash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + (expired ? -1000 : 3600000)).toISOString(),
  })
  return { user, token, hash, table, path: `/${family}/${token}` }
}
