import AuthLayout from '~/layouts/auth'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import { Form, Link } from '@adonisjs/inertia/react'

const fields = [{ name: 'email', label: 'Email' }] as const

export default function ForgotPassword() {
  return (
    <>
      <h1 className="auth__title">Forgot your password?</h1>
      <p className="auth__sub">Enter your email and we will send you a reset link.</p>

      <Form route="password_resets.store" resetOnSuccess onError={focusFormErrorSummary}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <FormErrorSummary errors={errors} fields={fields} />
            <div className="field">
              <label className="field__label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                className="field__input"
                autoComplete="username"
                placeholder="you@example.com"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? 'forgot-email-error' : undefined}
              />
              {errors.email && (
                <span id="forgot-email-error" className="field__error">
                  {errors.email}
                </span>
              )}
            </div>

            <button type="submit" className="btn btn--primary btn--block" disabled={processing}>
              {processing ? 'One moment…' : 'Send reset link'}
            </button>
          </div>
        )}
      </Form>

      <p className="auth__foot">
        Remembered it?{' '}
        <Link route="session.create" className="il">
          Sign in
        </Link>
      </p>
    </>
  )
}

ForgotPassword.layout = [AuthLayout]
