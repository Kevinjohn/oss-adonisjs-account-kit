import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { proofRequest, sendTokenPageHeaders } from '#services/token_page_headers'

export default class ProofResponseHeadersMiddleware {
  handle({ request, response }: HttpContext, next: NextFn) {
    if (proofRequest(request)) sendTokenPageHeaders(response)
    return next()
  }
}
