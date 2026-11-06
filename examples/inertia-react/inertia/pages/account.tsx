import Page from '~/components/page'
import AppLayout from '~/layouts/app'

export default function Account() {
  return (
    <Page
      title="Your account is confirmed"
      description="This page requires a signed-in account with a confirmed email address."
    >
      <div className="panel">
        <p>You have access to this protected application page.</p>
      </div>
    </Page>
  )
}

Account.layout = [AppLayout]
