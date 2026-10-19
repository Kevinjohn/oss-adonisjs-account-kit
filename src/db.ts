// Database helpers: re-exports transactions, user locks, unique-violation checks and token consumption.
export { transaction } from './transaction.js'
export { lockRow, lockUser, userMetadata } from './user_lock.js'
export {
  isUniqueViolation,
  isUserEmailUniqueViolation,
  mysqlDuplicateKey,
} from './unique_violation.js'
export { consumeToken, consumeUserToken, consumeUserTokenHash } from './token_consumption.js'
