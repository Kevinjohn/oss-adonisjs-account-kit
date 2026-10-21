# Inertia and React

With Inertia, your controllers call Account Kit and render React pages. Sign-in uses the session
guard, so set that up first with the [sessions recipe](sessions.md).

The [Inertia React example app](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/examples/inertia-react/README.md) puts this recipe together
with signup, email confirmation and password change in the official starter kit.

For profile and email settings, copy the example's authenticated `settings/profile` and
`settings/email` routes and its public `confirm-email/:token` GET/POST pair. The profile controller
passes only the signed-in user's ID, current password, and validated `fullName` to
`emailPasswordManagement.updateProfile`. An email request uses `requestEmailChange`; the confirmed
address remains active while the new address is pending. The confirmation GET calls
`inspectEmailChange` without using the proof, and the POST calls `completeEmailChange`, ends the
current browser session, and redirects to sign-in. Cancel a pending address through
`updateProfile({ actorId, currentPassword, email: currentEmail })`; the service also invalidates
its proof. Keep the profile and email settings routes behind authentication, and do not accept a
user ID from form data as authority. Show generic copy when an address cannot be used.
The example blocks email-change requests until the current address is confirmed, because the
service immediately changes an inactive account's address. Direct unconfirmed users to the
dashboard's verification resend action; this is an application policy, not a service restriction.

This recipe covers forgot password. Verification, invitations and email change follow the same
pattern: a form posts to a controller, the link in the email opens a page, and that page posts the
token back.

## Routes

```ts
// start/routes.ts
const PasswordResetsController = () => import('#controllers/password_resets_controller')

router.get('forgot-password', [PasswordResetsController, 'create'])
router.post('forgot-password', [PasswordResetsController, 'store'])
router.get('reset-password/:token', [PasswordResetsController, 'edit'])
router.post('reset-password/:token', [PasswordResetsController, 'update'])
```

Point the reset link at the page route in `config/account_kit.ts`:

```ts
urls: {
  passwordReset: (token) => new URL(`reset-password/${encodeURIComponent(token)}`, appUrl).toString(),
  // ...
},
```

## Controller

```ts
// app/controllers/password_resets_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import accountKit from 'adonisjs-account-kit/services/main'
import {
  DeliveryError,
  InvalidTokenError,
  PostCommitError,
  ThrottledError,
} from 'adonisjs-account-kit'

const emailValidator = vine.compile(vine.object({ email: vine.string().email() }))
const passwordValidator = vine.compile(
  vine.object({
    password: vine.string().minLength(8).maxLength(32),
    passwordConfirmation: vine.string().sameAs('password'),
  })
)

export default class PasswordResetsController {
  create({ inertia }: HttpContext) {
    return inertia.render('auth/forgot_password')
  }

  async store({ request, response, session, logger }: HttpContext) {
    const { email } = await request.validateUsing(emailValidator)
    try {
      await accountKit.passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (error instanceof ThrottledError) {
        session.flash('error', 'Too many attempts. Try again later.')
        return response.redirect().back()
      }
      // Only known addresses get an email, so a failed send must not change the response.
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      logger.error({ err: error }, 'password reset email failed')
    }
    session.flash('success', 'If the account exists, we have sent a reset link.')
    return response.redirect().back()
  }

  async edit({ inertia, params, response }: HttpContext) {
    // Keeps the token out of the Referer sent to other sites; same-origin still lets form errors
    // redirect back to this page.
    response.header('Referrer-Policy', 'same-origin')
    const valid = await accountKit.passwordReset.inspect({ token: params.token })
    return inertia.render('auth/reset_password', { token: params.token, valid })
  }

  async update({ request, response, session, params, logger }: HttpContext) {
    const { password } = await request.validateUsing(passwordValidator)
    try {
      await accountKit.passwordReset.reset({ token: params.token, password })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        session.flash('error', 'This link is invalid or has expired.')
        return response.redirect('/forgot-password')
      }
      // The password has already changed; only the follow-up email failed.
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      logger.error({ err: error }, 'password reset notice failed')
    }
    session.flash('success', 'Your password has been reset. Please sign in.')
    return response.redirect('/login')
  }
}
```

The example keeps the starter's 32-character ceiling for new passwords. Account Kit accepts new
passwords up to 256 UTF-16 code units by default; an application may choose a stricter
`passwordPolicy` and matching validator. Login does not apply that new-password policy, so existing
passwords up to the service's 256-unit ceiling remain usable. Keep the same new-password limit on
signup, reset and password-change forms.

`inspect` checks the link without using it up, so the page can show that a link cannot be used
before the user types a new password.

## Pages

```tsx
// inertia/pages/auth/forgot_password.tsx
import { useForm } from '@inertiajs/react'

export default function ForgotPassword() {
  const form = useForm({ email: '' })
  return (
    <form onSubmit={(event) => (event.preventDefault(), form.post('/forgot-password'))}>
      <label>
        Email
        <input
          type="email"
          value={form.data.email}
          onChange={(e) => form.setData('email', e.target.value)}
        />
      </label>
      {form.errors.email && <p>{form.errors.email}</p>}
      <button disabled={form.processing}>Send reset link</button>
    </form>
  )
}
```

```tsx
// inertia/pages/auth/reset_password.tsx
import { useForm, Link } from '@inertiajs/react'

export default function ResetPassword({ token, valid }: { token: string; valid: boolean }) {
  const form = useForm({ password: '', passwordConfirmation: '' })
  if (!valid)
    return (
      <p>
        This link may be invalid, already used, or expired.{' '}
        <Link href="/forgot-password">Request a new one</Link>.
      </p>
    )
  return (
    <form onSubmit={(event) => (event.preventDefault(), form.post(`/reset-password/${token}`))}>
      <label htmlFor="password">New password</label>
      <input
        id="password"
        name="password"
        type="password"
        value={form.data.password}
        onChange={(e) => form.setData('password', e.target.value)}
        aria-invalid={form.errors.password ? true : undefined}
        aria-describedby={form.errors.password ? 'password-error' : undefined}
      />
      {form.errors.password && <p id="password-error">{form.errors.password}</p>}
      <label htmlFor="passwordConfirmation">Confirm new password</label>
      <input
        id="passwordConfirmation"
        name="passwordConfirmation"
        type="password"
        value={form.data.passwordConfirmation}
        onChange={(e) => form.setData('passwordConfirmation', e.target.value)}
        aria-invalid={form.errors.passwordConfirmation ? true : undefined}
        aria-describedby={
          form.errors.passwordConfirmation ? 'password-confirmation-error' : undefined
        }
      />
      {form.errors.passwordConfirmation && (
        <p id="password-confirmation-error">{form.errors.passwordConfirmation}</p>
      )}
      <button disabled={form.processing}>Set new password</button>
    </form>
  )
}
```

Share the `success` and `error` flash messages with every page through your Inertia `sharedData`
config.

## Keep the token out of logs

The reset page URL contains the token. Exclude `/reset-password/*` and the other proof pages from
access logs, analytics and error reporting; see the [security model](../security.md).
