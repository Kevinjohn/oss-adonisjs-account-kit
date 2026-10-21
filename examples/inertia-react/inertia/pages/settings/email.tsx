import AppLayout from '~/layouts/app'
import SettingsLayout from '~/layouts/settings'
import Section from '~/components/section'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import { Form, Link } from '@adonisjs/inertia/react'
import type { InertiaProps } from '~/types'

type Props = InertiaProps<{ email: string; pendingEmail: string | null; canRequestChange: boolean }>
const requestFields = [
  { name: 'email', label: 'New email address' },
  { name: 'currentPassword', label: 'Current password' },
] as const
const cancelFields = [{ name: 'cancelCurrentPassword', label: 'Current password' }] as const

export default function Email({ email, pendingEmail, canRequestChange }: Props) {
  return (
    <Section
      title="Email"
      description="Your current address remains active until you confirm a new one."
    >
      <p>
        Current address: <strong style={{ overflowWrap: 'anywhere' }}>{email}</strong>
      </p>
      {pendingEmail && (
        <p>
          Pending confirmation: <strong style={{ overflowWrap: 'anywhere' }}>{pendingEmail}</strong>
        </p>
      )}
      {!canRequestChange && (
        <p>
          Confirm your current address before requesting a new one. Visit the{' '}
          <Link route="dashboard" className="il">
            dashboard
          </Link>{' '}
          to resend its verification link.
        </p>
      )}
      {canRequestChange && (
        <Form route="email_changes.store" onError={focusFormErrorSummary}>
          {({ errors, processing }) => (
            <div className="auth__form">
              <FormErrorSummary errors={errors} fields={requestFields} />
              <div className="field">
                <label className="field__label" htmlFor="email">
                  New email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  className="field__input"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  aria-describedby={errors.email ? 'email-email-error' : undefined}
                />
                {errors.email && (
                  <span id="email-email-error" className="field__error">
                    {errors.email}
                  </span>
                )}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="currentPassword">
                  Current password
                </label>
                <input
                  id="currentPassword"
                  name="currentPassword"
                  type="password"
                  className="field__input"
                  autoComplete="current-password"
                  aria-invalid={errors.currentPassword ? true : undefined}
                  aria-describedby={
                    errors.currentPassword ? 'email-currentPassword-error' : undefined
                  }
                />
                {errors.currentPassword && (
                  <span id="email-currentPassword-error" className="field__error">
                    {errors.currentPassword}
                  </span>
                )}
              </div>
              <button type="submit" className="btn btn--primary" disabled={processing}>
                {processing ? 'One moment…' : 'Request change'}
              </button>
            </div>
          )}
        </Form>
      )}
      {pendingEmail && (
        <Form route="email_changes.cancel" onError={focusFormErrorSummary}>
          {({ errors, processing }) => (
            <div className="auth__form">
              <p>Cancel the pending change with your current password.</p>
              <FormErrorSummary errors={errors} fields={cancelFields} />
              <div className="field">
                <label className="field__label" htmlFor="cancelCurrentPassword">
                  Current password
                </label>
                <input
                  id="cancelCurrentPassword"
                  name="cancelCurrentPassword"
                  type="password"
                  className="field__input"
                  autoComplete="current-password"
                  aria-invalid={errors.cancelCurrentPassword ? true : undefined}
                  aria-describedby={
                    errors.cancelCurrentPassword ? 'email-cancel-currentPassword-error' : undefined
                  }
                />
                {errors.cancelCurrentPassword && (
                  <span id="email-cancel-currentPassword-error" className="field__error">
                    {errors.cancelCurrentPassword}
                  </span>
                )}
              </div>
              <button type="submit" className="btn" disabled={processing}>
                {processing ? 'One moment…' : 'Cancel pending change'}
              </button>
            </div>
          )}
        </Form>
      )}
    </Section>
  )
}

Email.layout = [AppLayout, SettingsLayout]
