import type { HttpContext } from '@adonisjs/core/http'

/**
 * Keeps the token in a reset or verification page URL out of the Referer sent to other sites,
 * while form errors can still redirect back to the page.
 */
export function sendTokenPageHeaders(response: HttpContext['response']) {
  response.header('Referrer-Policy', 'same-origin')
}
