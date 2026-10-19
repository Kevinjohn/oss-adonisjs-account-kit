import type { Database } from '@adonisjs/lucid/database'
import type { Trx } from '../../src/types.js'

/** A database whose package transactions fail in a commit listener after committing. */
export function faultAfterCommit(db: Database, failure: Error): Database {
  return Object.create(db, {
    connection: {
      value: (...args: Parameters<Database['connection']>) => {
        const client = db.connection(...args)
        const begin = client.transaction.bind(client) as (...rest: unknown[]) => Promise<Trx>
        client.transaction = (async (...rest: unknown[]) => {
          const trx = await begin(...rest)
          trx.on('commit', () => {
            throw failure
          })
          return trx
        }) as typeof client.transaction
        return client
      },
    },
  })
}

/** Fault the commit of the nth package transaction only, counting from zero. */
export function faultNthCommit(db: Database, failure: Error, index: number): Database {
  let seen = 0
  return Object.create(db, {
    connection: {
      value: (...args: Parameters<Database['connection']>) => {
        const client = db.connection(...args)
        const begin = client.transaction.bind(client) as (...rest: unknown[]) => Promise<Trx>
        client.transaction = (async (...rest: unknown[]) => {
          const trx = await begin(...rest)
          if (seen++ === index) {
            trx.on('commit', () => {
              throw failure
            })
          }
          return trx
        }) as typeof client.transaction
        return client
      },
    },
  })
}
