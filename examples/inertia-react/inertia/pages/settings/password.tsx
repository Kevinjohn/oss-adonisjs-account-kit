import AppLayout from '~/layouts/app'
import Section from '~/components/section'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import SettingsLayout from '~/layouts/settings'
import { Form } from '@adonisjs/inertia/react'

const fields = [
  { name: 'currentPassword', label: 'Current password', autoComplete: 'current-password' },
  { name: 'password', label: 'New password', autoComplete: 'new-password' },
  { name: 'passwordConfirmation', label: 'Confirm new password', autoComplete: 'new-password' },
] as const

export default function Password() {
  return (
    <Section
      title="Password"
      description="Changing your password signs you out on every other device."
    >
      <Form route="passwords.update" resetOnSuccess onError={focusFormErrorSummary}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <FormErrorSummary errors={errors} fields={fields} />
            {fields.map(({ name, label, autoComplete }) => (
              <div className="field" key={name}>
                <label className="field__label" htmlFor={name}>
                  {label}
                </label>
                <input
                  id={name}
                  name={name}
                  type="password"
                  className="field__input"
                  autoComplete={autoComplete}
                  aria-invalid={errors[name] ? true : undefined}
                  aria-describedby={errors[name] ? `settings-${name}-error` : undefined}
                />
                {errors[name] && (
                  <span id={`settings-${name}-error`} className="field__error">
                    {errors[name]}
                  </span>
                )}
              </div>
            ))}

            <div>
              <button type="submit" className="btn btn--primary" disabled={processing}>
                {processing ? 'One moment…' : 'Change password'}
              </button>
            </div>
          </div>
        )}
      </Form>
    </Section>
  )
}

Password.layout = [AppLayout, SettingsLayout]
