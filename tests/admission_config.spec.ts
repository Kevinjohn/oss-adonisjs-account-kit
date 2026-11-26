import { test } from '@japa/runner'
import { resolveAdmissionConfig } from '../src/admission/config.ts'
import { defineConfig } from '../src/admission/config.ts'
import type { AdmissionConfig } from '../src/admission/types.ts'

const authorize = { decide: async () => true, list: async () => true }
const define = (config: unknown) => () => defineConfig(config as AdmissionConfig)

test.group('admission config', () => {
  test('requires at least one requirement', ({ assert }) => {
    assert.throws(define({}), /at least one of domain, invitation or approval/)
    assert.throws(define({ onAdmissionNotification: async () => {} }), /at least one/)
    assert.throws(define(null), /must be an object/)
  })

  test('resolves each requirement independently and none by default', ({ assert }) => {
    assert.deepEqual(defineConfig({ invitation: { required: true } }), {
      domain: null,
      invitation: true,
      approval: null,
    })
    const resolved = defineConfig({
      domain: { allowed: ['example.com', 'mail.example.org'], includeSubdomains: true },
      approval: { required: true, authorize },
    })
    assert.deepEqual(resolved.domain, {
      allowed: ['example.com', 'mail.example.org'],
      includeSubdomains: true,
    })
    assert.isFalse(resolved.invitation)
    assert.equal(resolved.approval?.authorize, authorize)
    assert.isFalse(defineConfig({ domain: { allowed: ['example.com'] } }).domain!.includeSubdomains)
  })

  test('rejects malformed allowed domains', ({ assert }) => {
    const bad = [
      'Example.com',
      'example',
      '.example.com',
      'example.com.',
      'user@example.com',
      '*.example.com',
      'exa mple.com',
      '-example.com',
      'example-.com',
      'example..com',
      'exämple.com',
      'a'.repeat(64) + '.com',
      Array.from({ length: 127 }, () => 'ab').join('.'),
      '',
      42,
    ]
    for (const entry of bad)
      assert.throws(
        define({ domain: { allowed: [entry] } }),
        /domain\.allowed entry/,
        String(entry)
      )
    assert.doesNotThrow(
      define({ domain: { allowed: ['a'.repeat(63) + '.co', 'x-1.example.com'] } })
    )
    assert.throws(define({ domain: { allowed: [] } }), /non-empty array/)
    assert.throws(define({ domain: { allowed: 'example.com' } }), /non-empty array/)
    assert.throws(define({ domain: [] }), /domain must be an object/)
    assert.throws(
      define({ domain: { allowed: ['example.com'], includeSubdomains: 'yes' } }),
      /includeSubdomains must be a boolean/
    )
  })

  test('requires an explicit required flag to enable invitation and approval', ({ assert }) => {
    assert.throws(define({ invitation: {} }), /invitation must be \{ required: true \}/)
    assert.throws(define({ invitation: { required: false } }), /invitation must be/)
    assert.throws(define({ approval: { authorize } }), /approval must have required: true/)
  })

  test('requires both approval callbacks', ({ assert }) => {
    // A missing `authorize` may still be registered; the provider checks it on first resolution.
    const deferred = defineConfig({ approval: { required: true } })
    assert.throws(
      () => resolveAdmissionConfig(deferred, undefined),
      /approval\.authorize must be an object/
    )
    assert.throws(
      define({ approval: { required: true, authorize: { list: async () => true } } }),
      /approval\.authorize\.decide must be a function/
    )
    assert.throws(
      define({ approval: { required: true, authorize: { decide: async () => true } } }),
      /approval\.authorize\.list must be a function/
    )
  })

  test('accepts an event hook only as a function', ({ assert }) => {
    const hook = async () => {}
    assert.equal(
      defineConfig({ invitation: { required: true }, onAdmissionNotification: hook })
        .onAdmissionNotification,
      hook
    )
    assert.throws(
      define({ invitation: { required: true }, onAdmissionNotification: 'log' }),
      /onAdmissionNotification must be a function/
    )
  })
})
