# Inertia and React

With Inertia, your controllers call Account Kit and render React pages. Sign-in uses the session
guard, so set that up first with the [sessions recipe](sessions.md).

The [Inertia React example app](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/examples/inertia-react/README.md) puts this recipe together
with signup, email confirmation and password change in the official starter kit.

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
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import vine from '@vinejs/vine'
import {
  AccountKit,
  DeliveryError,
  InvalidTokenError,
  PostCommitError,
  ThrottledError,
} from 'adonisjs-account-kit'

const emailValidator = vine.compile(vine.object({ email: vine.string().email() }))
const passwordValidator = vine.compile(
  vine.object({ password: vine.string().minLength(8).maxLength(256).confirmed() })
)

export default class PasswordResetsController {
  create({ inertia }: HttpContext) {
    return inertia.render('auth/forgot_password')
  }

  async store({ request, response, session, logger }: HttpContext) {
    const { email } = await request.validateUsing(emailValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.request({ email, clientKey: request.ip() })
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
    const kit = await app.container.make(AccountKit)
    const valid = await kit.passwordReset.inspect({ token: params.token })
    return inertia.render('auth/reset_password', { token: params.token, valid })
  }

  async update({ request, response, session, params }: HttpContext) {
    const { password } = await request.validateUsing(passwordValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.reset({ token: params.token, password })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        session.flash('error', 'This link is invalid or has expired.')
        return response.redirect('/forgot-password')
      }
      throw error
    }
    session.flash('success', 'Your password has been reset. Please sign in.')
    return response.redirect('/login')
  }
}
```

`inspect` checks the link without using it up, so the page can show "this link has expired"
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
  const form = useForm({ password: '', password_confirmation: '' })
  if (!valid)
    return (
      <p>
        This link is invalid or has expired. <Link href="/forgot-password">Request a new one</Link>.
      </p>
    )
  return (
    <form onSubmit={(event) => (event.preventDefault(), form.post(`/reset-password/${token}`))}>
      <input
        type="password"
        value={form.data.password}
        onChange={(e) => form.setData('password', e.target.value)}
      />
      <input
        type="password"
        value={form.data.password_confirmation}
        onChange={(e) => form.setData('password_confirmation', e.target.value)}
      />
      {form.errors.password && <p>{form.errors.password}</p>}
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
