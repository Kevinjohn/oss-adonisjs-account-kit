/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

router.on('/').renderInertia('home', {}).as('home')

router
  .group(() => {
    router.get('signup', [controllers.NewAccount, 'create'])
    router.post('signup', [controllers.NewAccount, 'store'])

    router.get('login', [controllers.Session, 'create'])
    router.post('login', [controllers.Session, 'store'])

    router.get('forgot-password', [controllers.PasswordResets, 'create'])
    router.post('forgot-password', [controllers.PasswordResets, 'store'])
  })
  .use(middleware.guest())

// A reset link can belong to this session's account or to someone else using this browser.
// Inspection never changes the signed-in identity; a successful reset ends the old session.
router.get('reset-password/:token', [controllers.PasswordResets, 'edit'])
router.post('reset-password/:token', [controllers.PasswordResets, 'update'])

// The link in a verification email works whether or not the user is signed in.
router.get('verify-email/:token', [controllers.EmailVerifications, 'edit'])
router.post('verify-email/:token', [controllers.EmailVerifications, 'update'])

// Inspect the address-owner's link without changing this browser's signed-in identity.
router.get('confirm-email/:token', [controllers.EmailChanges, 'confirm'])
router.post('confirm-email/:token', [controllers.EmailChanges, 'complete'])

router
  .group(() => {
    router.on('/dashboard').renderInertia('dashboard', {}).as('dashboard')
    router.post('logout', [controllers.Session, 'destroy'])
    router.post('email-verification', [controllers.EmailVerifications, 'store'])
    router.get('settings/profile', [controllers.Profile, 'edit'])
    router.post('settings/profile', [controllers.Profile, 'update'])
    router.get('settings/email', [controllers.EmailChanges, 'edit'])
    router.post('settings/email', [controllers.EmailChanges, 'store'])
    router.post('settings/email/cancel', [controllers.EmailChanges, 'cancel'])
    router.get('settings/password', [controllers.Passwords, 'edit'])
    router.post('settings/password', [controllers.Passwords, 'update'])
  })
  .use(middleware.auth())
