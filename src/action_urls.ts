// Action URLs: builds email links from configured origins and relative page paths.
import type { UrlCallbacks } from './types.js'

/**
 * Options for `createActionUrls`: the backend and frontend origins, the relative path of each page,
 * and the environment. Production origins must be HTTPS.
 */
export interface ActionUrlOptions {
  /** The API's public origin. */
  backendOrigin: string
  /** The frontend URL the links point at, including any base path. */
  appFrontendUrl: string
  /**
   * The relative page path for each kind of link, such as `reset-password`. The token is appended.
   */
  destinations: Partial<Record<keyof UrlCallbacks, string>>
  /** In production, origins must be HTTPS; HTTP is allowed only for loopback in development. */
  environment: 'development' | 'test' | 'production'
}

export function trustedOrigin(value: string, environment: ActionUrlOptions['environment']): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('account_kit: invalid configured origin')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new Error('account_kit: invalid configured origin')
  if (environment === 'production' && url.protocol !== 'https:')
    throw new Error('account_kit: public production origins require HTTPS')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('account_kit: HTTP is restricted to loopback development origins')
  return url
}

/** Build links only from configured values; request Host and forwarded headers are never inputs. */
export function createActionUrls(options: ActionUrlOptions): UrlCallbacks {
  trustedOrigin(options.backendOrigin, options.environment)
  const frontend = trustedOrigin(options.appFrontendUrl, options.environment)
  const base = new URL(frontend.toString().replace(/\/?$/, '/'))
  function link(name: keyof UrlCallbacks, token: string): string {
    const destination = options.destinations[name]
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
      throw new Error(`account_kit: ${name} destination must be a relative path`)
    try {
      if (
        destination.split('/').some((segment) => {
          const decoded = decodeURIComponent(segment)
          return (
            decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')
          )
        })
      )
        throw new Error('unsafe path segment')
      const resolved = new URL(
        `${destination.replace(/\/?$/, '/')}${encodeURIComponent(token)}`,
        base
      )
      if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname))
        throw new Error('outside configured frontend')
      return resolved.toString()
    } catch {
      throw new Error(
        `account_kit: ${name} destination must stay below the configured frontend path`
      )
    }
  }
  for (const [name, destination] of Object.entries(options.destinations)) {
    if (destination !== undefined) link(name as keyof UrlCallbacks, 'check')
  }
  return {
    passwordReset: (token) => link('passwordReset', token),
    emailVerification: (token) => link('emailVerification', token),
    invitation: (token) => link('invitation', token),
    emailChange: (token) => link('emailChange', token),
    magicLink: (token) => link('magicLink', token),
  }
}
