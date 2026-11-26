import type { HttpContext } from '@adonisjs/core/http'
import type { SocialProviderName } from '../types.ts'
import type { ManagedSocialExtension } from './social.ts'
import { getOptionalSession } from './session_access.ts'

/** A server-held visitor preference, never an account lookup or authentication signal. */
export async function rememberManagedMethod(
  context: HttpContext,
  method: 'password' | SocialProviderName,
  extension?: ManagedSocialExtension
): Promise<void> {
  try {
    getOptionalSession(context)?.put('accountKit.social.lastUsedMethod', method)
    await extension?.rememberLastUsedMethod?.(context, method)
  } catch {
    // A visitor preference cannot turn an established credential into a failed login.
  }
}
