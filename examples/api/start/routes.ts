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

router.post('/account-kit/recovery', [controllers.AccountKit, 'recoveryRequest'])
router.get('/account-kit/recovery/:token', [controllers.AccountKit, 'recoveryInspect'])
router.post('/account-kit/recovery/:token', [controllers.AccountKit, 'recoveryReset'])
router.get('/account-kit/invitation/:token', [controllers.AccountKit, 'invitationInspect'])
router.post('/account-kit/invitation/:token', [controllers.AccountKit, 'invitationAccept'])
router.get('/account-kit/email-change/:token', [controllers.AccountKit, 'emailChangeInspect'])
router.post('/account-kit/email-change/:token', [controllers.AccountKit, 'emailChangeComplete'])
router
  .group(() => {
    router.post('/invitations', [controllers.AccountKit, 'invitationSend'])
    router.get('/invitations', [controllers.AccountKit, 'invitationList'])
    router.post('/invitations/:id/resend', [controllers.AccountKit, 'invitationResend'])
    router.delete('/invitations/:id', [controllers.AccountKit, 'invitationRevoke'])
    router.post('/credentials/password', [controllers.AccountKit, 'changePassword'])
  })
  .prefix('/account-kit')
  .use(middleware.auth())
  .use(middleware.verifiedAccount())

router
  .post('/account-kit/credentials/email', [controllers.AccountKit, 'requestEmailChange'])
  .use(middleware.auth())
  .use(middleware.accountAccess())

router
  .post('/account-kit/verification/send', [controllers.AccountKit, 'verificationSend'])
  .use(middleware.auth())
  .use(middleware.accountAccess())

router.post('/account-kit/verification/:token', [controllers.AccountKit, 'verificationComplete'])

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
