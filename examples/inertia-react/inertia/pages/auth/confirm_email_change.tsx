import AuthLayout from '~/layouts/auth'
import { Form, Link } from '@adonisjs/inertia/react'
import type { InertiaProps } from '~/types'

type Props = InertiaProps<{ token: string; valid: boolean }>

export default function ConfirmEmailChange({ token, valid, user }: Props) {
  if (!valid) {
    return (
      <>
        <h1 className="auth__title">This link can’t be used</h1>
        <p className="auth__sub">It may be invalid, already used, or expired.</p>
        {user ? (
          <Link route="email_changes.edit" className="btn btn--primary btn--block">
            Email settings
          </Link>
        ) : (
          <Link route="session.create" className="btn btn--primary btn--block">
            Sign in
          </Link>
        )}
      </>
    )
  }

  return (
    <>
      <h1 className="auth__title">Confirm your new email</h1>
      <p className="auth__sub">
        Confirming changes your sign-in address and ends current sessions. Sign in again with the
        new address.
      </p>
      <Form route="email_changes.complete" routeParams={{ token }}>
        {({ processing }) => (
          <button type="submit" className="btn btn--primary btn--block" disabled={processing}>
            {processing ? 'One moment…' : 'Confirm email change'}
          </button>
        )}
      </Form>
    </>
  )
}

ConfirmEmailChange.layout = [AuthLayout]
