import { compose } from '@adonisjs/core/helpers'
import { afterDelete, beforeDelete, beforeSave, beforeUpdate } from '@adonisjs/lucid/orm'
import { SoftDeletes } from '@kevinjohn/adonisjs-lucid-soft-delete'
import LucidUser from './lucid_user.js'

export default class SoftDeletingUser extends compose(LucidUser, SoftDeletes) {
  static table = 'users'
  static hookCalls: string[] = []
  static observeAfterDelete?: (user: SoftDeletingUser) => Promise<void>

  @beforeDelete()
  static recordBeforeDelete() {
    this.hookCalls.push('beforeDelete')
  }

  @afterDelete()
  static async recordAfterDelete(user: SoftDeletingUser) {
    this.hookCalls.push('afterDelete')
    await this.observeAfterDelete?.(user)
  }

  @beforeSave()
  static recordSave() {
    this.hookCalls.push('beforeSave')
  }

  @beforeUpdate()
  static recordUpdate() {
    this.hookCalls.push('beforeUpdate')
  }
}
