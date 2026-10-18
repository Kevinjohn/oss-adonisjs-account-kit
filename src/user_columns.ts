// The users-table columns every maintained adapter requires, by conventional property name.
export const canonicalUserColumns = [
  ['id', 'id'],
  ['email', 'email'],
  ['unverifiedEmail', 'unverified_email'],
  ['password', 'password'],
  ['emailVerifiedAt', 'email_verified_at'],
] as const
