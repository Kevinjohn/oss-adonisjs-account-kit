import AuthLayout from '~/layouts/auth'
import { Form, Link } from '@adonisjs/inertia/react'
import { type InertiaProps } from '~/types'

type Props = InertiaProps<{ token: string; valid: boolean }>

export default function VerifyEmail({ token, valid, user }: Props) {
  if (!valid) {
    return (
      <>
        <h1 className="auth__title">This link can’t be used</h1>
        <p className="auth__sub">
          It may be invalid, already used, or expired. Request a new verification link from the
          dashboard.
        </p>
        <Link
          route={user ? 'dashboard' : 'session.create'}
          className="btn btn--primary btn--block"
          style={{ marginTop: 16 }}
        >
          {user ? 'Go to dashboard' : 'Sign in'}
        </Link>
      </>
    )
  }

  return (
    <>
      <h1 className="auth__title">Confirm your email</h1>
      <p className="auth__sub">
        Choose the password for this account. It replaces the one used at signup.
      </p>

      <Form route="email_verifications.update" routeParams={{ token }}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <div className="field">
              <label className="field__label" htmlFor="password">
                Password
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
                Confirm password
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
              {processing ? 'One moment…' : 'Confirm email'}
            </button>
          </div>
        )}
      </Form>
    </>
  )
}

VerifyEmail.layout = [AuthLayout]
