import { DateTime } from 'luxon'
import { beforeSave, BaseModel, column } from '@adonisjs/lucid/orm'

export default class User extends BaseModel {
  static table = 'users'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'full_name' })
  declare fullName: string

  @column()
  declare email: string

  @column({ columnName: 'unverified_email' })
  declare unverifiedEmail: string | null

  @column()
  declare password: string | null

  @column.dateTime({ columnName: 'email_verified_at' })
  declare emailVerifiedAt: DateTime | null

  @column.dateTime({ columnName: 'created_at', autoCreate: true })
  declare createdAt: DateTime

  @beforeSave()
  static async hashPassword(user: User) {
    user.email = user.email.trim().toLowerCase()
    if (user.$dirty.password && user.password) {
      const { default: hash } = await import('@adonisjs/core/services/hash')
      user.password = await hash.make(user.password)
    }
  }
}
