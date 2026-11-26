/* eslint-disable @unicorn/no-await-expression-member -- Keep each assertion next to its request. */

import User from '#models/user'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'

export type RecipeDelivery = { sentInvitations: string[] }

export type Snapshot = { accounts: unknown[]; access: unknown[] }

export async function truncateRecipeDatabase() {
  const truncate = await testUtils.db().truncate()
  await truncate()
  await db.table('account_transaction_lock').insert({ id: 1, version: 0 })
}

export async function snapshot(): Promise<Snapshot> {
  return {
    accounts: await db.from('users').orderBy('id'),
    access: await db.from('app_user_roles').orderBy('id'),
  }
}

export async function tokenFor(user: User, abilities: string[] = ['*']): Promise<string> {
  const token = await User.accessTokens.create(user, abilities, { expiresIn: '1d' })
  return token.value!.release()
}
