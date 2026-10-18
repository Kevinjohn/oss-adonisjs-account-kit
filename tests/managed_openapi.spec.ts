import { test } from '@japa/runner'
import { generateManagedOpenApi } from '../src/http/openapi.js'
import { managedEndpointSchemas } from '../src/http/openapi_schemas.js'
import { compileEmbedded, documentErrors, documentFor, registered } from './helpers/openapi.js'

function embeddedSchemas(document: ReturnType<typeof documentFor>): unknown[] {
  const schemas: unknown[] = Object.values(document.components.schemas)
  for (const methods of Object.values(document.paths))
    for (const operation of Object.values(methods) as Array<Record<string, any>>) {
      for (const parameter of operation.parameters ?? []) schemas.push(parameter.schema)
      if (operation.requestBody)
        schemas.push(operation.requestBody.content['application/json'].schema)
      for (const response of Object.values(operation.responses) as Array<Record<string, any>>)
        for (const media of Object.values(response.content ?? {}) as Array<{ schema: unknown }>)
          schemas.push(media.schema)
    }
  return schemas
}

test.group('managed OpenAPI document', () => {
  for (const strategy of ['session', 'access_tokens'] as const) {
    test(`the ${strategy} document is valid OpenAPI 3.1 and every schema compiles`, ({
      assert,
    }) => {
      const document = documentFor(strategy)
      assert.deepEqual(documentErrors(document), [])
      const schemas = embeddedSchemas(document)
      assert.isAbove(schemas.length, 100)
      for (const schema of schemas) compileEmbedded(document, schema)
    })
  }

  test('the validators reject an invalid document and an invalid schema', ({ assert }) => {
    const document = documentFor('session')
    assert.isNotEmpty(documentErrors({ ...document, openapi: '3.0.3' }))
    const broken = structuredClone(document) as any
    delete broken.paths['/api/v1/auth/login'].post.responses[200].description
    assert.isNotEmpty(documentErrors(broken))
    assert.throws(() => compileEmbedded(document, { type: 'not-a-type' }))
    assert.throws(() => compileEmbedded(document, { $ref: '#/components/schemas/Missing' }))
  })

  test('every managed endpoint has schemas and a unique operation', ({ assert }) => {
    const document = documentFor('session')
    const operations = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId as string)
    )
    const tokenOperations = Object.values(documentFor('access_tokens').paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId as string)
    )
    assert.sameMembers(
      [...new Set([...operations, ...tokenOperations])],
      Object.keys(managedEndpointSchemas)
    )
    assert.equal(new Set(operations).size, operations.length)
  })

  test('documents exactly the selected routes under the registered prefix', ({ assert }) => {
    const document = generateManagedOpenApi({
      registration: registered('session', {
        prefix: '/accounts',
        enabled: ['authentication', 'passwordReset'],
        except: ['auth.passwordReset.inspect'],
        extensions: {},
      }),
      info: { title: 'Selected', version: '2.0.0' },
    })
    assert.deepEqual(Object.keys(document.paths), [
      '/accounts/auth/csrf',
      '/accounts/auth/login',
      '/accounts/auth/password-reset',
      '/accounts/auth/password-reset/{token}',
      '/accounts/account/logout',
      '/accounts/account/profile',
    ])
    assert.deepEqual(Object.keys(document.paths['/accounts/auth/password-reset/{token}']), ['post'])
    assert.deepEqual(
      document.tags.map((tag: { name: string }) => tag.name),
      ['authentication', 'passwordReset']
    )
    assert.deepEqual(document.info, { title: 'Selected', version: '2.0.0' })
  })

  test('strategy-specific routes, security and the token field follow the guard', ({ assert }) => {
    const session = documentFor('session')
    const tokens = documentFor('access_tokens')
    assert.property(session.paths, '/api/v1/auth/csrf')
    assert.notProperty(tokens.paths, '/api/v1/auth/csrf')
    assert.notProperty(session.paths, '/api/v1/auth/oauth/token')
    assert.property(tokens.paths, '/api/v1/auth/oauth/token')
    assert.notProperty(session.paths['/api/v1/auth/oauth/{provider}/callback'], 'post')
    assert.property(tokens.paths['/api/v1/auth/oauth/{provider}/callback'], 'post')

    assert.deepEqual(Object.keys(session.components.securitySchemes as object), [
      'sessionCookie',
      'csrfToken',
    ])
    assert.equal((session.components.securitySchemes as any).sessionCookie.name, 'adonis-session')
    assert.deepEqual(session.paths['/api/v1/auth/login'].post.security, [
      { sessionCookie: [], csrfToken: [] },
    ])
    assert.deepEqual(session.paths['/api/v1/auth/csrf'].get.security, [])
    assert.deepEqual(session.paths['/api/v1/account/profile'].get.security, [{ sessionCookie: [] }])
    assert.deepEqual(tokens.paths['/api/v1/account/profile'].get.security, [{ bearerToken: [] }])
    assert.deepEqual(tokens.paths['/api/v1/auth/login'].post.security, [])
    assert.deepEqual(tokens.paths['/api/v1/auth/oauth/{provider}/redirect'].post.security, [
      {},
      { bearerToken: [] },
    ])

    const login = (document: typeof session) =>
      (document.paths['/api/v1/auth/login'].post as any).responses[200].content['application/json']
        .schema
    assert.deepEqual(login(session).required, ['account'])
    assert.notProperty(login(session).properties, 'token')
    assert.deepEqual(login(tokens).required, ['account', 'token'])
    const redirect = (document: typeof session) =>
      (document.paths['/api/v1/auth/oauth/{provider}/redirect'].post as any).requestBody.content[
        'application/json'
      ].schema
    assert.deepEqual(redirect(tokens).required, ['clientChallenge'])
    assert.deepEqual(redirect(session).required, [])
  })

  test('responses document committed writes, errors, headers and parameters', ({ assert }) => {
    const document = documentFor('session')
    const responses = (path: string, method: string) =>
      (document.paths[path][method] as any).responses as Record<string, any>
    const write = responses('/api/v1/account/password', 'post')
    assert.deepEqual(write[202].content['application/json'].schema, {
      $ref: '#/components/schemas/ManagedCommittedSuccess',
    })
    assert.includeMembers(Object.keys(write), ['200', '202', '401', '403', '422', '429', '500'])
    assert.notProperty(responses('/api/v1/account/profile', 'get'), '202')
    assert.property(responses('/api/v1/auth/oauth/{provider}/callback', 'get'), '202')
    assert.deepEqual(
      responses('/api/v1/auth/password-reset', 'post')[202].content['application/json'].schema
        .oneOf[1],
      { $ref: '#/components/schemas/ManagedCommittedSuccess' }
    )

    const proof = responses('/api/v1/auth/password-reset/{token}', 'post')
    assert.property(proof, '400')
    assert.deepEqual(Object.keys(proof[200].headers), ['Cache-Control', 'Referrer-Policy'])
    assert.property(proof[400].headers, 'Referrer-Policy')
    assert.property(proof[429].headers, 'Retry-After')
    assert.property(proof[429].headers, 'Vary')
    assert.deepEqual(Object.keys(proof[400].content), [
      'application/json',
      'application/vnd.api+json',
    ])
    assert.deepEqual(Object.keys(responses('/api/v1/auth/csrf', 'get')[200].headers), [
      'Cache-Control',
    ])
    assert.notProperty(responses('/api/v1/auth/login', 'post'), '400')
    assert.property(responses('/api/v1/account/invitations/{id}', 'delete'), '404')
    assert.property(responses('/api/v1/account/invitations', 'post'), '409')
    assert.notProperty(responses('/api/v1/account/logout', 'post'), '422')
    assert.property(responses('/api/v1/auth/oauth/{provider}/callback', 'get'), '401')
    assert.notProperty(responses('/api/v1/auth/password-reset', 'post'), '401')

    const unlink = document.paths['/api/v1/account/social-identities/{id}'].delete as any
    assert.deepEqual(unlink.parameters[0].schema, { type: 'string', pattern: '^[1-9][0-9]*$' })
    const provider = document.paths['/api/v1/auth/oauth/{provider}/redirect'].post as any
    assert.deepEqual(provider.parameters[0].schema, { $ref: '#/components/schemas/SocialProvider' })
    assert.deepEqual(document.components.schemas.SocialProvider, { enum: ['google', 'github'] })
    const list = document.paths['/api/v1/account/invitations'].get as any
    assert.deepEqual(
      list.parameters.map((parameter: { name: string; in: string }) => parameter.in),
      ['query', 'query']
    )
  })

  test('the session cookie name and info are taken from the input', ({ assert }) => {
    const document = generateManagedOpenApi({
      registration: registered('session'),
      info: { title: 'Named', version: '3.0.0', description: 'Accounts' },
      sessionCookieName: 'app-session',
    })
    assert.equal((document.components.securitySchemes as any).sessionCookie.name, 'app-session')
    assert.equal(document.info.description, 'Accounts')
  })

  test('an application account schema replaces the default account body', ({ assert }) => {
    const accountSchema = {
      type: 'object',
      properties: { id: { type: 'integer' }, displayName: { type: 'string' } },
      required: ['id', 'displayName'],
    }
    const document = documentFor('session', {
      extensions: {
        social: { providers: ['google'] },
        representAccount: (account) => ({ id: account.id, displayName: 'x' }),
      },
      openapi: { accountSchema },
    })
    assert.deepEqual(documentErrors(document), [])
    assert.deepEqual(document.components.schemas.Account, accountSchema)
    assert.deepEqual(document.components.schemas.IssuedAccount.anyOf, [
      { $ref: '#/components/schemas/Account' },
      { $ref: '#/components/schemas/SafeAccount' },
    ])
    const show = (document.paths['/api/v1/account/profile'].get as any).responses[200].content[
      'application/json'
    ].schema
    assert.deepEqual(show.properties.account, { $ref: '#/components/schemas/Account' })
    const social = compileEmbedded(document, document.components.schemas.SocialFlowResult)
    assert.isFalse(social({ status: 'linked', account: { id: 1, displayName: 'x' } }))
  })

  test('replaced validators and account representation must provide schemas', ({ assert }) => {
    const validate = async () => ({ email: 'a@example.test', password: 'password123' })
    assert.throws(
      () => documentFor('session', { extensions: { registration: { validate } } }),
      /requestBodies\['auth.signup'\]/
    )
    assert.throws(
      () =>
        documentFor('session', {
          extensions: { invitationAcceptance: { validate } },
        }),
      /requestBodies\['auth.invitation.accept'\]/
    )
    assert.throws(
      () => documentFor('session', { extensions: { profile: { validate: async () => ({}) } } }),
      /requestBodies\['account.profile.update'\]/
    )
    assert.throws(
      () => documentFor('session', { extensions: { representAccount: () => ({}) } }),
      /openapi.accountSchema/
    )
    // A replaced validator on an unmounted route needs no schema.
    assert.doesNotThrow(() =>
      documentFor('session', {
        enabled: ['authentication'],
        extensions: { registration: { validate } },
      })
    )

    const signup = { type: 'object', properties: { handle: { type: 'string' } } }
    const document = generateManagedOpenApi({
      registration: registered('session', {
        extensions: { social: { providers: ['google'] }, registration: { validate } },
      }),
      info: { title: 'x', version: '1' },
      requestBodies: { 'auth.signup': signup },
    })
    assert.deepEqual(
      (document.paths['/api/v1/auth/signup'].post as any).requestBody.content['application/json']
        .schema,
      signup
    )
  })

  test('the registration manifest records the mounted selection once', ({ assert }) => {
    const registration = registered('access_tokens', { enabled: ['invitations'], extensions: {} })
    assert.equal(registration.strategy, 'access_tokens')
    assert.equal(registration.prefix, '/api/v1')
    assert.deepEqual(registration.socialProviders, [])
    assert.deepEqual(
      registration.routes.map((route) => route.name),
      [
        'auth.invitation.inspect',
        'auth.invitation.accept',
        'account.invitation.send',
        'account.invitation.list',
        'account.invitation.resend',
        'account.invitation.revoke',
      ]
    )
  })
})
