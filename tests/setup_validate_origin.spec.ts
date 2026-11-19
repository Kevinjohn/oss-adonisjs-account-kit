import { test } from '@japa/runner'
import { addOriginDiagnostics } from '../src/setup/diagnostics.js'
import type { SetupDiagnostic } from '../src/setup/types.js'

function check(variable: string, value: string | undefined, production = false) {
  const diagnostics: SetupDiagnostic[] = []
  addOriginDiagnostics(diagnostics, 'field', variable, {
    production,
    env: value === undefined ? {} : { [variable]: value },
  })
  return diagnostics
}

test.group('setup origin validation', () => {
  test('rejects a variable name that is not an environment variable', ({ assert }) => {
    const diagnostics = check('https://app.example.test', 'ignored')
    assert.lengthOf(diagnostics, 1)
    assert.equal(diagnostics[0].severity, 'error')
    assert.match(diagnostics[0].message, /uppercase environment variable name/)
  })

  test('accepts HTTPS anywhere and HTTP on loopback outside production', ({ assert }) => {
    assert.deepEqual(check('APP_URL', 'https://app.example.test', true), [])
    assert.deepEqual(check('APP_URL', 'http://localhost:3333'), [])
    assert.deepEqual(check('APP_URL', 'http://127.0.0.1'), [])
    assert.deepEqual(check('APP_URL', 'http://[::1]:3333'), [])
  })

  test('rejects HTTP on a non-loopback host outside production', ({ assert }) => {
    const diagnostics = check('APP_URL', 'http://app.example.test')
    assert.lengthOf(diagnostics, 1)
    assert.match(diagnostics[0].message, /APP_URL may use HTTP only for loopback development/)
  })

  test('rejects HTTP in production even on loopback', ({ assert }) => {
    const diagnostics = check('APP_URL', 'http://localhost', true)
    assert.lengthOf(diagnostics, 1)
    assert.match(diagnostics[0].message, /APP_URL must use HTTPS in production/)
  })

  test('rejects credentials, query, fragment, other schemes and unparseable values', ({
    assert,
  }) => {
    for (const value of [
      'https://user:secret@app.example.test',
      'https://app.example.test/?next=1',
      'https://app.example.test/#top',
      'ftp://app.example.test',
      'not a url',
    ]) {
      const diagnostics = check('APP_URL', value)
      assert.lengthOf(diagnostics, 1, value)
      assert.equal(diagnostics[0].severity, 'error', value)
      assert.match(
        diagnostics[0].message,
        /APP_URL must be a valid trusted HTTP\(S\) origin/,
        value
      )
      assert.notInclude(diagnostics[0].message, 'secret', value)
    }
  })

  test('a resolved value takes precedence over the process environment', ({ assert }) => {
    const diagnostics: SetupDiagnostic[] = []
    addOriginDiagnostics(diagnostics, 'field', 'APP_URL', {
      production: true,
      env: { APP_URL: 'https://from-process.example.test' },
      resolvedValue: 'http://from-file.example.test',
    })
    assert.lengthOf(diagnostics, 1)
    assert.match(diagnostics[0].message, /must use HTTPS in production/)
    addOriginDiagnostics(diagnostics, 'field', 'APP_URL', {
      production: true,
      env: { APP_URL: 'http://x.test' },
      resolvedValue: null,
    })
    assert.lengthOf(diagnostics, 2)
    assert.equal(diagnostics[1].severity, 'action')
    assert.match(diagnostics[1].message, /APP_URL must be set/)
  })
})
