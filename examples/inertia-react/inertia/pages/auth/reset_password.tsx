import AuthLayout from '~/layouts/auth'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import { Form, Link } from '@adonisjs/inertia/react'
import { type InertiaProps } from '~/types'

type Props = InertiaProps<{ token: string; valid: boolean }>

const fields = [
  { name: 'password', label: 'New password' },
  { name: 'passwordConfirmation', label: 'Confirm new password' },
] as const

export default function ResetPassword({ token, valid, user }: Props) {
  if (!valid) {
    return (
      <>
        <h1 className="auth__title">This link can’t be used</h1>
        <p className="auth__sub">It may be invalid, already used, or expired.</p>
        {user ? (
          <>
            <p className="auth__foot">Sign out to request a new link or sign in with a password.</p>
            <Form route="session.destroy">
              <button type="submit" className="btn btn--primary btn--block">
                Sign out
              </button>
            </Form>
          </>
        ) : (
          <>
            <Link
              route="password_resets.create"
              className="btn btn--primary btn--block"
              style={{ marginTop: 16 }}
            >
              Request a new link
            </Link>
            <p className="auth__foot">
              Already have a password?{' '}
              <Link route="session.create" className="il">
                Sign in
              </Link>
            </p>
          </>
        )}
      </>
    )
  }

  return (
    <>
      <h1 className="auth__title">Choose a new password</h1>
      <p className="auth__sub">
        Any current session will end. Sign in with the new password after resetting it.
      </p>

      <Form route="password_resets.update" routeParams={{ token }} onError={focusFormErrorSummary}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <FormErrorSummary errors={errors} fields={fields} />
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
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={errors.password ? 'reset-password-error' : undefined}
              />
              {errors.password && (
                <span id="reset-password-error" className="field__error">
                  {errors.password}
                </span>
              )}
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
                aria-invalid={errors.passwordConfirmation ? true : undefined}
                aria-describedby={
                  errors.passwordConfirmation ? 'reset-passwordConfirmation-error' : undefined
                }
              />
              {errors.passwordConfirmation && (
                <span id="reset-passwordConfirmation-error" className="field__error">
                  {errors.passwordConfirmation}
                </span>
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
