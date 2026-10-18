import { DateTime } from 'luxon'
import type { AccountUser } from '../../src/types.js'
import type { TestApp } from './app.js'
import { makeUsersAdapter, unwrapId } from './users_adapter.js'

/** Insert a user row directly; `password: null` makes a social-only account. */
export async function insertUser(
  kit: TestApp,
  options: { email?: string; password?: string | null; verified?: boolean } = {}
): Promise<AccountUser> {
  const { email = 'person@example.test', password = 'password123', verified = true } = options
  const [id] = await kit.db
    .table('users')
    .insert({
      email,
      unverified_email: verified ? null : email,
      password: password === null ? null : await kit.hash.make(password),
      email_verified_at: verified ? DateTime.utc().toISO() : null,
      created_at: DateTime.utc().toISO(),
    })
    .returning('id')
  return (await makeUsersAdapter(kit.db, kit.hash).findById(unwrapId(id)))!
}
