import { test } from '@japa/runner'
import { generateToken, hashToken, isTokenShaped } from '../../src/tokens.js'

test.group('tokens', () => {
  test('generates distinct 40-byte base64url tokens and hashes them as stable SHA-256 hex', async ({
    assert,
  }) => {
    const token = generateToken()
    const another = generateToken()
    assert.equal(Buffer.from(token, 'base64url').length, 40)
    assert.match(token, /^[A-Za-z0-9_-]{54}$/)
    assert.notEqual(token, another)
    assert.match(hashToken(token), /^[a-f0-9]{64}$/)
    assert.equal(hashToken(token), hashToken(token))
  })

  test('accepts configured and outstanding token lengths with canonical base64url', async ({
    assert,
  }) => {
    assert.isTrue(isTokenShaped(generateToken(32)))
    assert.isTrue(isTokenShaped(generateToken()))
    assert.isFalse(isTokenShaped('a'.repeat(21)))
    assert.isFalse(isTokenShaped('a'.repeat(87)))
    assert.isFalse(isTokenShaped(`${'a'.repeat(42)}+`))
    assert.isFalse(isTokenShaped(null))
  })
})
