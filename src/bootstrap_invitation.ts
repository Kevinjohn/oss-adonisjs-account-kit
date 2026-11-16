// Reserve the invitation address before writing the approval bound to its replacement.
import { DateTime } from 'luxon'
import { EmailAlreadyRegisteredError } from './errors.js'
import { toInvitation } from './invitation_rows.js'
import { hashToken } from './tokens.js'
import { sqlTimestamp } from './timestamps.js'
import { expiresAt } from './ttl.js'
import type { Invitation, ResolvedConfig, Trx } from './types.js'

export async function replaceBootstrapInvitation(
  config: ResolvedConfig,
  trx: Trx,
  input: { email: string; role: string; token: string }
): Promise<Invitation> {
  const now = DateTime.utc()
  const row = {
    email: input.email,
    role: input.role,
    scope: '',
    inviter_id: null,
    token_hash: hashToken(input.token),
    expires_at: sqlTimestamp(trx, expiresAt(now, config.expiresIn.invitation)),
    created_at: sqlTimestamp(trx, now),
    updated_at: sqlTimestamp(trx, now),
  }
  // A stored-column assignment preserves the old token while locking even an absent key.
  // MySQL may instead encounter another unique index; verify the requested key below.
  await trx
    .table('account_invitations')
    .insert(row)
    .onConflict(['email', 'scope'])
    .merge({
      email: trx.raw('??', ['account_invitations.email']),
    })
  const locked = await trx
    .from('account_invitations')
    .where('email', input.email)
    .where('scope', '')
    .forUpdate()
    .first()
  if (!locked) {
    // Surface the conflicting unique key rather than silently accepting MySQL's other target.
    await trx.table('account_invitations').insert(row)
    throw new Error('Bootstrap invitation address reservation failed')
  }
  if (await config.users.findByEmail(input.email, trx)) throw new EmailAlreadyRegisteredError()
  // Reservation and eligibility may have waited; the committed link gets its full lifetime.
  const issuedAt = DateTime.utc()
  const fresh = {
    ...row,
    expires_at: sqlTimestamp(trx, expiresAt(issuedAt, config.expiresIn.invitation)),
    created_at: sqlTimestamp(trx, issuedAt),
    updated_at: sqlTimestamp(trx, issuedAt),
  }
  if (locked.token_hash === row.token_hash) {
    await trx.from('account_invitations').where('id', locked.id).update(fresh)
  } else {
    await trx.from('account_invitations').where('id', locked.id).delete()
    await trx.table('account_invitations').insert(fresh)
  }
  const issued = await trx
    .from('account_invitations')
    .where('email', input.email)
    .where('scope', '')
    .first()
  return toInvitation(issued)
}
