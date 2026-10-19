import { randomUUID } from 'node:crypto'
import { UserSchema } from '#database/schema'
import hash from '@adonisjs/core/services/hash'
import { compose } from '@adonisjs/core/helpers'
import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { type AccessToken, DbAccessTokensProvider } from '@adonisjs/auth/access_tokens'
import { beforeCreate, beforeSave } from '@adonisjs/lucid/orm'
import env from '#start/env'

const idType = env.get('ACCOUNT_KIT_USER_ID_TYPE') ?? 'integer'

export default class User extends compose(UserSchema, withAuthFinder(hash)) {
  static table = env.get('ACCOUNT_KIT_USERS_TABLE') ?? 'users'
  static selfAssignPrimaryKey = idType !== 'integer'
  static accessTokens = DbAccessTokensProvider.forModel(User)
  declare currentAccessToken?: AccessToken

  @beforeCreate()
  static assignStringId(user: User) {
    if (idType !== 'integer' && !user.id) {
      Object.assign(user, { id: randomUUID() })
    }
  }

  @beforeSave()
  static normalizeEmail(user: User) {
    user.email = user.email.trim().toLowerCase()
  }

  get initials() {
    const [first, last] = this.fullName ? this.fullName.split(' ') : this.email.split('@')
    if (first && last) {
      return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase()
    }
    return `${first.slice(0, 2)}`.toUpperCase()
  }
}
