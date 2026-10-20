import db from '@adonisjs/lucid/services/db'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

/** Clear recorded notifications and the account rows the HTTP workflow specs create. */
export async function resetAccountState() {
  notifications.reset()
  await db.from('role_assignments').delete()
  await db.from('password_reset_tokens').delete()
  await db.from('account_invitations').delete()
  await db.from('email_verification_tokens').delete()
  await db.from('auth_access_tokens').delete()
  await User.query().delete()
}
