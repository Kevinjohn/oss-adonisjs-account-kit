import type { HttpContext } from '@adonisjs/core/http'

export type Route = 'dashboard' | 'session.create'

export function makeContext() {
  const flashes: Array<[string, string]> = []
  const routes: Route[] = []
  const loggedErrors: unknown[] = []
  const ctx = {
    request: {
      async validateUsing() {
        return {
          fullName: 'Signup Test',
          email: 'signup@example.test',
          password: 'SignupPass123!',
        }
      },
      ip: () => '127.0.0.1',
    },
    response: {
      redirect: () => ({
        toRoute(route: Route) {
          routes.push(route)
          return route
        },
      }),
    },
    auth: { use: () => ({}) },
    session: {
      flash: (key: string, value: string) => flashes.push([key, value]),
      regenerate() {},
      put() {},
    },
    logger: { error: (...args: unknown[]) => loggedErrors.push(args) },
  } as unknown as HttpContext

  return { ctx, flashes, routes, loggedErrors }
}

export function replaceMethod(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  return () => {
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  }
}
