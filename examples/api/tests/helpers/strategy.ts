/** True when the example runs with `ACCOUNT_KIT_AUTH_STRATEGY=session`. */
export const isSessionStrategy = process.env.ACCOUNT_KIT_AUTH_STRATEGY === 'session'

/** Skip reason for tests that need the access-token strategy. */
export const ACCESS_TOKENS_ONLY = 'Runs only with ACCOUNT_KIT_AUTH_STRATEGY=access_tokens'

/** Skip reason for tests that need the session strategy. */
export const SESSION_ONLY = 'Runs only with ACCOUNT_KIT_AUTH_STRATEGY=session'
