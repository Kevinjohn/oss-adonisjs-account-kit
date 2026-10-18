import AuthLayout from '~/layouts/auth'
import { Form, Link } from '@adonisjs/inertia/react'
import { type InertiaProps } from '~/types'

type Props = InertiaProps<{ token: string; valid: boolean }>

export default function ResetPassword({ token, valid }: Props) {
  if (!valid) {
    return (
      <>
        <h1 className="auth__title">This link has expired</h1>
        <p className="auth__sub">Reset links work once and expire after an hour.</p>
        <Link
          route="password_resets.create"
          className="btn btn--primary btn--block"
          style={{ marginTop: 16 }}
        >
          Request a new link
        </Link>
      </>
    )
  }

  return (
    <>
      <h1 className="auth__title">Choose a new password</h1>
      <p className="auth__sub">You will sign in with it from now on.</p>

      <Form route="password_resets.update" routeParams={{ token }}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <div className="field">
              <label className="field__label" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                className="field__input"
                autoComplete="new-password"
                aria-invalid={errors.password ? 'true' : 'false'}
              />
              {errors.password && <span className="field__error">{errors.password}</span>}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="passwordConfirmation">
                Confirm new password
              </label>
              <input
                id="passwordConfirmation"
                name="passwordConfirmation"
                type="password"
                className="field__input"
                autoComplete="new-password"
                aria-invalid={errors.passwordConfirmation ? 'true' : 'false'}
              />
              {errors.passwordConfirmation && (
                <span className="field__error">{errors.passwordConfirmation}</span>
              )}
            </div>

            <button type="submit" className="btn btn--primary btn--block" disabled={processing}>
              {processing ? 'One moment…' : 'Reset password'}
            </button>
          </div>
        )}
      </Form>
    </>
  )
}

ResetPassword.layout = [AuthLayout]
