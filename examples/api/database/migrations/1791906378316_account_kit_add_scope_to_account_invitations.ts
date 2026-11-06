import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'account_invitations'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('scope', 255).notNullable().defaultTo('')
      table.dropUnique(['email'])
      table.unique(['email', 'scope'])
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['email', 'scope'])
      table.unique(['email'])
      table.dropColumn('scope')
    })
  }
}
