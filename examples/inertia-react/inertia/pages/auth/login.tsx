import AuthLayout from '~/layouts/auth'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import { Form, Link } from '@adonisjs/inertia/react'

const fields = [
  { name: 'email', label: 'Email' },
  { name: 'password', label: 'Password' },
] as const

export default function Login() {
  return (
    <>
      <h1 className="auth__title">Welcome back</h1>
      <p className="auth__sub">Sign in to continue building.</p>

      <Form route="session.store" onError={focusFormErrorSummary}>
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
                aria-describedby={errors.email ? 'login-email-error' : undefined}
              />
              {errors.email && (
                <span id="login-email-error" className="field__error">
                  {errors.email}
                </span>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                className="field__input"
                autoComplete="current-password"
                placeholder="••••••••"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={errors.password ? 'login-password-error' : undefined}
              />
              {errors.password && (
                <span id="login-password-error" className="field__error">
                  {errors.password}
                </span>
              )}
            </div>

            <Link route="password_resets.create" className="il" style={{ fontSize: 13 }}>
              Forgot your password?
            </Link>

            <button
              type="submit"
              className="btn btn--primary btn--block"
              disabled={processing}
              style={{ marginTop: 4 }}
            >
              {processing ? 'One moment…' : 'Sign in'}
            </button>
          </div>
        )}
      </Form>

      <p className="auth__foot">
        New here?{' '}
        <Link route="new_account.create" className="il">
          Create an account
        </Link>
      </p>
    </>
  )
}

Login.layout = [AuthLayout]
