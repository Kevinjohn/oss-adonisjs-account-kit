import { BaseModel } from '@adonisjs/lucid/orm'
import { beforeSave, column } from '@adonisjs/lucid/orm'
import type { DateTime } from 'luxon'

export default class LucidUser extends BaseModel {
  static table = 'users'
  static hashCalls = 0
  static hashPassword: (password: string) => Promise<string> = async (password) =>
    `hashed:${password}`

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare email: string

  @column()
  declare password: string | null

  @column.dateTime({ columnName: 'email_verified_at' })
  declare emailVerifiedAt: DateTime | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column({ columnName: 'full_name' })
  declare fullName: string | null

  @column()
  declare role: string | null

  @beforeSave()
  static async hashPasswordBeforeSave(user: LucidUser): Promise<void> {
    if (user.$dirty.password && user.password && !user.password.startsWith('hashed:')) {
      this.hashCalls += 1
      user.password = await this.hashPassword(user.password!)
    }
  }
}
