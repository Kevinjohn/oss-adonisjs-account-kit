import app from '@adonisjs/core/services/app'
import { ExceptionHandler } from '@adonisjs/core/http'

/** Minimal application-owned handler compatible with the preserved baseline package. */
export default class HttpExceptionHandler extends ExceptionHandler {
  protected debug = !app.inProduction
}
