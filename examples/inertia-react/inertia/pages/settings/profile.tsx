import AppLayout from '~/layouts/app'
import SettingsLayout from '~/layouts/settings'
import Section from '~/components/section'
import FormErrorSummary, { focusFormErrorSummary } from '~/components/form_error_summary'
import { Form } from '@adonisjs/inertia/react'
import type { InertiaProps } from '~/types'

type Props = InertiaProps<{ profile: { fullName: string | null; email: string } }>
const fields = [
  { name: 'fullName', label: 'Full name' },
  { name: 'currentPassword', label: 'Current password' },
] as const

export default function Profile({ profile }: Props) {
  return (
    <Section
      title="Profile"
      description="Your name saves immediately. Confirm with your current password."
    >
      <Form route="profile.update" onError={focusFormErrorSummary}>
        {({ errors, processing }) => (
          <div className="auth__form">
            <FormErrorSummary errors={errors} fields={fields} />
            <div className="field">
              <label className="field__label" htmlFor="fullName">
                Full name
              </label>
              <input
                id="fullName"
                name="fullName"
                type="text"
                className="field__input"
                autoComplete="name"
                defaultValue={profile.fullName ?? ''}
                aria-invalid={errors.fullName ? true : undefined}
                aria-describedby={errors.fullName ? 'profile-fullName-error' : undefined}
              />
              {errors.fullName && (
                <span id="profile-fullName-error" className="field__error">
                  {errors.fullName}
                </span>
              )}
            </div>
            <p>
              Signed in as <span style={{ overflowWrap: 'anywhere' }}>{profile.email}</span>
            </p>
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
                  errors.currentPassword ? 'profile-currentPassword-error' : undefined
                }
              />
              {errors.currentPassword && (
                <span id="profile-currentPassword-error" className="field__error">
                  {errors.currentPassword}
                </span>
              )}
            </div>
            <button type="submit" className="btn btn--primary" disabled={processing}>
              {processing ? 'One moment…' : 'Save profile'}
            </button>
          </div>
        )}
      </Form>
    </Section>
  )
}

Profile.layout = [AppLayout, SettingsLayout]
