/** Anything that can say which SQL dialect it talks to: a query client, transaction or database. */
export type DialectSource =
  | { dialect: { name: string } }
  | {
      /** The connection whose dialect is read, as on a Lucid database. */
      connection(): { dialect: { name: string } }
    }
