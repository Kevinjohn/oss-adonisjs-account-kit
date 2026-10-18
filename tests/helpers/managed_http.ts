import type { HttpContext, Router } from '@adonisjs/core/http'

export function fixture() {
  const routes = new Map<string, (context: HttpContext) => Promise<unknown>>()
  const committed: Array<{ methods: string[]; pattern: string; name: string }> = []
  const pending: Array<{ methods: string[]; pattern: string; name: string }> = []
  let didCommit = false
  const router = {
    toJSON: () => ({ root: committed }),
    route(path: string, methods: string[], handler: (context: HttpContext) => Promise<unknown>) {
      routes.set(`${methods[0]} ${path}`, handler)
      const definition = { methods, pattern: path, name: '' }
      pending.push(definition)
      return {
        as(name: string) {
          definition.name = name
          return this
        },
      }
    },
    commit() {
      if (!didCommit) committed.push(...pending)
      didCommit = true
    },
  } as unknown as Router
  function context(params: Record<string, string> = {}) {
    const headers: Record<string, string> = {}
    const response = {
      header(name: string, value: string) {
        headers[name] = value
        return this
      },
      getHeader(name: string) {
        return headers[name]
      },
      status(status: number) {
        return { send: (body: unknown) => ({ status, body }) }
      },
      ok(body: unknown) {
        return { status: 200, body }
      },
      accepted(body: unknown) {
        return { status: 202, body }
      },
      created(body: unknown) {
        return { status: 201, body }
      },
      noContent() {
        return { status: 204 }
      },
      unprocessableEntity(body: unknown) {
        return { status: 422, body }
      },
    }
    return {
      params,
      request: {
        ip: () => '192.0.2.1',
        header: () => undefined,
        validateUsing: async () => ({ email: 'a@example.test', password: 'password123' }),
      },
      response,
      headers,
    } as unknown as HttpContext & { headers: Record<string, string> }
  }
  return { router, routes, context, pending }
}
