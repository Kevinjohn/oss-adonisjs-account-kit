import Page from '~/components/page'
import { LayoutGrid } from 'lucide-react'
import AppLayout from '~/layouts/app'
import { usePage } from '@inertiajs/react'
import { Form } from '@adonisjs/inertia/react'

/**
 * New accounts are limited until the email address is confirmed. Routes that need a confirmed
 * address can call `kit.authentication.requireActive` instead of `current`.
 */
function VerifyEmailNotice() {
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

export default function Dashboard() {
  return (
    <Page title="Dashboard" hideTitle>
      <VerifyEmailNotice />
      <div className="empty">
        <div className="empty__mark">
          <LayoutGrid size={22} />
        </div>
        <h1>Your dashboard is ready</h1>
        <p>
          It&apos;s empty on purpose. A clean starting point with nothing to undo. Add your first
          route and component to begin.
        </p>
        <p className="mono" style={{ fontSize: 12.5, color: 'var(--subtle)', marginTop: 4 }}>
          Start in <span className="kbd">inertia/pages/dashboard.tsx</span>
        </p>
      </div>
    </Page>
  )
}

Dashboard.layout = [AppLayout]
