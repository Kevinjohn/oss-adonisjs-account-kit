/** Access to the AdonisJS session store that managed session flows keep server-side state in. */
import type { HttpContext } from '@adonisjs/core/http'

export interface SessionStore {
  get(key: string): unknown
  put(key: string, value: unknown): void
  forget(key: string): void
}

/** The request's session store, or `undefined` when session middleware is not installed. */
export function optionalSession(context: HttpContext): SessionStore | undefined {
  const value = (context as HttpContext & { session?: SessionStore }).session
  return value &&
    typeof value.get === 'function' &&
    typeof value.put === 'function' &&
    typeof value.forget === 'function'
    ? value
    : undefined
}

/** The request's session store; throws `message` when session middleware is not installed. */
export function requireSession(context: HttpContext, message: string): SessionStore {
  const value = (context as HttpContext & { session?: SessionStore }).session
  if (!value?.get || !value.put || !value.forget) throw new Error(message)
  return value
}
