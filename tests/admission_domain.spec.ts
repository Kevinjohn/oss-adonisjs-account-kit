import { test } from '@japa/runner'
import { domainAllowed, domainOf } from '../src/admission/domain.js'

const exact = { allowed: ['example.com'], includeSubdomains: false }
const nested = { allowed: ['example.com'], includeSubdomains: true }
const matches = (email: string, rule = exact) => {
  const domain = domainOf(email)
  return domain !== null && domainAllowed(domain, rule)
}

test.group('admission domain', () => {
  test('matches the exact domain only unless subdomains are included', ({ assert }) => {
    assert.isTrue(matches('person@example.com'))
    assert.isFalse(matches('person@mail.example.com'))
    assert.isTrue(matches('person@mail.example.com', nested))
    assert.isTrue(matches('person@a.b.example.com', nested))
    assert.isTrue(matches('person@example.com', nested))
  })

  test('refuses look-alike domains', ({ assert }) => {
    for (const email of [
      'person@example.com.evil',
      'person@evil-example.com',
      'person@evilexample.com',
      'person@example.co',
    ]) {
      assert.isFalse(matches(email), email)
      assert.isFalse(matches(email, nested), email)
    }
  })

  test('fails closed for a trailing dot and malformed addresses', ({ assert }) => {
    for (const email of [
      'person@example.com.',
      'a@b@example.com',
      '@example.com',
      'person@',
      'example.com',
      'person@.example.com',
    ]) {
      assert.isFalse(matches(email), email)
      assert.isFalse(matches(email, nested), email)
    }
    assert.isNull(domainOf('a@b@example.com'))
    assert.isNull(domainOf('@example.com'))
  })

  test('never matches a Unicode domain, with or without subdomains', ({ assert }) => {
    assert.isFalse(matches('person@exämple.com'))
    assert.isFalse(matches('person@bücher.example.com', nested))
    assert.isFalse(
      domainAllowed('exämple.com', { allowed: ['xn--exmple-cua.com'], includeSubdomains: false })
    )
  })
})
