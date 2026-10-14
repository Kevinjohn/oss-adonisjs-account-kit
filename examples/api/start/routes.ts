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
import { loginClientThrottle, loginThrottle } from '#start/limiter'

router.get('/', () => {
  return { hello: 'world' }
})

router.post('/account-kit/recovery', [controllers.AccountKit, 'recoveryRequest'])
router.get('/account-kit/recovery/:token', [controllers.AccountKit, 'recoveryInspect'])
router.post('/account-kit/recovery/:token', [controllers.AccountKit, 'recoveryReset'])
router.get('/account-kit/verification/:token', [controllers.AccountKit, 'verificationComplete'])
router.get('/account-kit/invitation/:token', [controllers.AccountKit, 'invitationInspect'])
router.post('/account-kit/invitation/:token', [controllers.AccountKit, 'invitationAccept'])
router.get('/account-kit/email-change/:token', [controllers.AccountKit, 'emailChangeInspect'])
router.post('/account-kit/email-change/:token', [controllers.AccountKit, 'emailChangeComplete'])
router
  .group(() => {
    router.post('/verification/send', [controllers.AccountKit, 'verificationSend'])
    router.post('/invitations', [controllers.AccountKit, 'invitationSend'])
    router.get('/invitations', [controllers.AccountKit, 'invitationList'])
    router.post('/invitations/:id/resend', [controllers.AccountKit, 'invitationResend'])
    router.delete('/invitations/:id', [controllers.AccountKit, 'invitationRevoke'])
    router.post('/credentials/password', [controllers.AccountKit, 'changePassword'])
    router.post('/credentials/email', [controllers.AccountKit, 'requestEmailChange'])
  })
  .prefix('/account-kit')
  .use(middleware.auth())

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router
          .post('login', [controllers.AccessTokens, 'store'])
          .use([loginClientThrottle, loginThrottle])
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())
  })
  .prefix('/api/v1')
