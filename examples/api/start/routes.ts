/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
| The auth strategy switch exists so the test harness can run both strategies.
| An application keeps one strategy and copies only its branch.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'
import { authStrategy } from '#services/auth_strategy'

const strategy = authStrategy()

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    router
      .group(() => {
        router.post('signup', [controllers.NewAccount, 'store'])
        router.get('social-verification/:token', [controllers.SocialAuth, 'verificationEntry'])
        if (strategy === 'session') router.get('csrf', [controllers.Session, 'csrf'])
        if (strategy === 'session') router.post('login', [controllers.Session, 'store'])
        else router.post('login', [controllers.AccessTokens, 'store'])
        router.post('password-reset', [controllers.PasswordResets, 'request'])
        router.get('password-reset/:token', [controllers.PasswordResets, 'inspect'])
        router.post('password-reset/:token', [controllers.PasswordResets, 'complete'])
        router.get('email-verification/:token', [controllers.EmailVerifications, 'inspect'])
        router.post('email-verification/:token', [controllers.EmailVerifications, 'complete'])
        router.get('email-change/:token', [controllers.Profile, 'inspectEmailChange'])
        router.post('email-change/:token', [controllers.Profile, 'completeEmailChange'])
        router.get('invitations/:token', [controllers.Invitations, 'inspect'])
        router.post('invitations/:token', [controllers.Invitations, 'accept'])
        router
          .post('oauth/:provider/redirect', [controllers.SocialAuth, 'redirect'])
          .use(middleware.socialThrottle({ operation: 'begin' }))
        router
          .post('oauth/:provider/confirm', [controllers.SocialAuth, 'confirm'])
          .use(middleware.socialThrottle({ operation: 'confirm' }))
        if (strategy === 'session') {
          router
            .get('oauth/:provider/callback', [controllers.SocialAuth, 'callback'])
            .use(middleware.socialThrottle({ operation: 'callback' }))
        } else {
          router
            .post('oauth/:provider/callback', [controllers.SocialAuth, 'callback'])
            .use(middleware.socialThrottle({ operation: 'callback' }))
          router
            .post('oauth/token', [controllers.OauthToken, 'redeem'])
            .use(middleware.socialThrottle({ operation: 'redeem' }))
        }
        router
          .post('oauth/registration', [controllers.SocialAuth, 'completeRegistration'])
          .use(middleware.socialThrottle({ operation: 'registration' }))
      })
      .prefix('auth')
      .as('auth')

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show']).use(middleware.accountAccess())
        router.patch('profile', [controllers.Profile, 'update']).use(middleware.accountAccess())
        router.get('methods', [controllers.AuthMethods, 'methods']).use(middleware.accountAccess())
        router
          .post('social/proof', [controllers.SocialIdentities, 'provePassword'])
          .use(middleware.accountAccess())
          .use(middleware.socialThrottle({ operation: 'proof', actor: true }))
        router
          .delete('social/:id', [controllers.SocialIdentities, 'unlink'])
          .use(middleware.accountAccess())
          .use(middleware.socialThrottle({ operation: 'unlink', actor: true }))
        if (strategy === 'session') router.post('logout', [controllers.Session, 'destroy'])
        else router.post('logout', [controllers.AccessTokens, 'destroy'])
        router
          .post('email-verification/send', [controllers.EmailVerifications, 'send'])
          .use(middleware.accountAccess())
        router
          .post('password', [controllers.AccountPassword, 'update'])
          .use(middleware.verifiedAccount())
        router
          .post('invitations', [controllers.Invitations, 'send'])
          .use(middleware.verifiedAccount())
        router
          .get('invitations', [controllers.Invitations, 'list'])
          .use(middleware.verifiedAccount())
        router
          .post('invitations/:id/resend', [controllers.Invitations, 'resend'])
          .use(middleware.verifiedAccount())
        router
          .delete('invitations/:id', [controllers.Invitations, 'revoke'])
          .use(middleware.verifiedAccount())
      })
      .prefix('account')
      .as('account')
      .use(middleware.auth())
  })
  .prefix('/api/v1')
