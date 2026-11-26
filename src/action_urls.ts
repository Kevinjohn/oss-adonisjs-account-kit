import { InvalidArgumentsException } from '@adonisjs/core/exceptions'
// Action URLs: builds email links from configured origins and relative page paths.
import type { UrlCallbacks } from './types.ts'
import type { ActionUrlOptions } from './types_notifications.ts'

export type { ActionUrlOptions } from './types_notifications.ts'

export const actionUrlBackendOrigins = new WeakMap<object, { value: string; setting?: string }>()

export function requireTrustedOrigin(
  value: string,
  environment: ActionUrlOptions['environment']
): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new InvalidArgumentsException('account_kit: invalid configured origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new InvalidArgumentsException('account_kit: invalid configured origin')
  if (environment === 'production' && url.protocol !== 'https:')
    throw new InvalidArgumentsException('account_kit: public production origins require HTTPS')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new InvalidArgumentsException(
      'account_kit: HTTP is restricted to loopback development origins'
    )
  return url
}

/**
 * Build links only from configured values; request Host and forwarded headers are never inputs.
 *
 * @example
 * ```ts
 * import { createActionUrls } from '@kevinjohn/adonisjs-account-kit'
 *
 * const urls = createActionUrls({
 *   backendOrigin: 'https://api.example.test',
 *   appFrontendUrl: 'https://app.example.test',
 *   destinations: { passwordReset: 'reset-password' },
 *   environment: 'production',
 * })
 * ```
 */
export function createActionUrls(options: ActionUrlOptions): UrlCallbacks {
  return new ActionUrls(options)
}

class ActionUrls implements UrlCallbacks {
  #options: ActionUrlOptions
  #base: URL

  constructor(options: ActionUrlOptions) {
    this.#options = options
    const { backendOrigin, backendOriginSetting } = options
    try {
      requireTrustedOrigin(backendOrigin, options.environment)
    } catch (error) {
      if (!(error instanceof Error) || !options.backendOriginSetting) throw error
      throw new InvalidArgumentsException(
        `account_kit: ${backendOriginSetting}: ${error.message.replace('account_kit: ', '')}`,
        {
          cause: error,
        }
      )
    }
    const frontend = requireTrustedOrigin(options.appFrontendUrl, options.environment)
    this.#base = new URL(frontend.toString().replace(/\/?$/, '/'))
    for (const [name, destination] of Object.entries(options.destinations)) {
      if (destination !== undefined) this.#link(name as keyof UrlCallbacks, 'check')
    }
    actionUrlBackendOrigins.set(this, { value: backendOrigin, setting: backendOriginSetting })
  }

  #link(name: keyof UrlCallbacks, token: string): string {
    const destination = this.#options.destinations[name]
    if (
      !destination ||
      destination.trim() !== destination ||
      destination.startsWith('/') ||
      destination.includes('..') ||
      destination.includes('\\') ||
      destination.includes('?') ||
      destination.includes('#') ||
      [...destination].some((character) => character.charCodeAt(0) < 32) ||
      /^[a-z][a-z\d+.-]*:/i.test(destination) ||
      destination.startsWith('//')
    )
      throw new InvalidArgumentsException(
        `account_kit: ${name} destination must be a relative path`
      )
    try {
      if (
        destination.split('/').some((segment) => {
          const decoded = decodeURIComponent(segment)
          return (
            decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
          )
        })
      )
        throw new InvalidArgumentsException('unsafe path segment')
      const resolved = new URL(
        `${destination.replace(/\/?$/, '/')}${encodeURIComponent(token)}`,
        this.#base
      )
      if (
        resolved.origin !== this.#base.origin ||
        !resolved.pathname.startsWith(this.#base.pathname)
      )
        throw new InvalidArgumentsException('outside configured frontend')
      return resolved.toString()
    } catch {
      throw new InvalidArgumentsException(
        `account_kit: ${name} destination must stay below the configured frontend path`
      )
    }
  }

  passwordReset: UrlCallbacks['passwordReset'] = (token) => this.#link('passwordReset', token)
  emailVerification: UrlCallbacks['emailVerification'] = (token) =>
    this.#link('emailVerification', token)
  invitation: UrlCallbacks['invitation'] = (token) => this.#link('invitation', token)
  emailChange: UrlCallbacks['emailChange'] = (token) => this.#link('emailChange', token)
  magicLink: UrlCallbacks['magicLink'] = (token) => this.#link('magicLink', token)
}
