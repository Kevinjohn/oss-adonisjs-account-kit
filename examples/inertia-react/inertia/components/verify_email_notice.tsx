import { usePage } from '@inertiajs/react'
import { Form } from '@adonisjs/inertia/react'

/**
 * New accounts are limited until the email address is confirmed. Routes that need a confirmed
 * address can call `kit.authentication.requireActive` instead of `current`.
 */
export default function VerifyEmailNotice() {
  const { emailVerified } = usePage().props
  if (emailVerified) return null
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 16 }}>
      <Form route="email_verifications.store">
        {({ processing }) => (
          <p style={{ display: 'flex', gap: 12, alignItems: 'center', margin: 0 }}>
            Confirm your email address with the link we sent you.
            <button type="submit" className="btn btn--secondary btn--sm" disabled={processing}>
              Resend link
            </button>
          </p>
        )}
      </Form>
    </div>
  )
}
