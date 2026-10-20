import { test } from '@japa/runner'
import router from '@adonisjs/core/services/router'

test('reset proof inspection and completion remain reachable during an existing session', ({
  assert,
}) => {
  const routes = router.toJSON().root ?? []
  for (const method of ['GET', 'POST']) {
    const route = routes.find(
      (candidate) =>
        candidate.pattern === '/reset-password/:token' && candidate.methods.includes(method)
    )
    assert.exists(route)
    const middlewareNames = Array.from(route!.middleware.all(), (entry) => entry.name)
    assert.notInclude(middlewareNames, 'guest')
  }
  for (const path of ['/signup', '/login']) {
    const route = routes.find(
      (candidate) => candidate.pattern === path && candidate.methods.includes('GET')
    )
    assert.exists(route)
    assert.include(
      Array.from(route!.middleware.all(), (entry) => entry.name),
      'guest'
    )
  }
})
