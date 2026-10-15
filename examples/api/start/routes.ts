/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'
import env from '#start/env'

const strategy = env.get('ACCOUNT_KIT_AUTH_STRATEGY') ?? 'access_tokens'

router.get('/', () => {
  return { hello: 'world' }
})

router.post('/account-kit/recovery', [controllers.PasswordResets, 'request'])
router.get('/account-kit/recovery/:token', [controllers.PasswordResets, 'inspect'])
router.post('/account-kit/recovery/:token', [controllers.PasswordResets, 'complete'])
router
  .post('/account-kit/verification/send', [controllers.EmailVerifications, 'send'])
  .use(middleware.auth())
  .use(middleware.accountAccess())
router.get('/account-kit/verification/:token', [controllers.EmailVerifications, 'inspect'])
router.post('/account-kit/verification/:token', [controllers.EmailVerifications, 'complete'])
router.get('/account-kit/invitation/:token', [controllers.Invitations, 'inspect'])
router.post('/account-kit/invitation/:token', [controllers.Invitations, 'accept'])
router.get('/account-kit/email-change/:token', [controllers.Profile, 'inspectEmailChange'])
router.post('/account-kit/email-change/:token', [controllers.Profile, 'completeEmailChange'])
router
  .group(() => {
    router.post('/invitations', [controllers.Invitations, 'send'])
    router.get('/invitations', [controllers.Invitations, 'list'])
    router.post('/invitations/:id/resend', [controllers.Invitations, 'resend'])
    router.delete('/invitations/:id', [controllers.Invitations, 'revoke'])
    router.post('/credentials/password', [controllers.AccountPassword, 'update'])
  })
  .prefix('/account-kit')
  .use(middleware.auth())
  .use(middleware.verifiedAccount())

router
  .post('/account-kit/credentials/email', [controllers.Profile, 'requestEmailChange'])
  .use(middleware.auth())
  .use(middleware.accountAccess())

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        if (strategy === 'session') router.get('csrf', [controllers.Session, 'csrf'])
        if (strategy === 'session') router.post('login', [controllers.Session, 'store'])
        else router.post('login', [controllers.AccessTokens, 'store'])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show']).use(middleware.accountAccess())
        if (strategy === 'session') router.post('logout', [controllers.Session, 'destroy'])
        else router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
  })
  .prefix('/api/v1')
