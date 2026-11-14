/** The NOT NULL columns of `auth_access_tokens` that fixtures do not otherwise care about. */
export const accessTokenDefaults = { type: 'auth_token', abilities: '["*"]' } as const
