import type { HttpContext } from '@adonisjs/core/http'
import type { SocialProviderName } from '../types.js'
import type { ManagedSocialExtension } from './social.js'
import { optionalSession } from './social_session_state.js'

/** A server-held visitor preference, never an account lookup or authentication signal. */
export async function rememberManagedMethod(
  context: HttpContext,
  method: 'password' | SocialProviderName,
  extension?: ManagedSocialExtension
): Promise<void> {
  try {
    optionalSession(context)?.put('accountKit.social.lastUsedMethod', method)
    await extension?.rememberLastUsedMethod?.(context, method)
  } catch {
    // A visitor preference cannot turn an established credential into a failed login.
  }
}
