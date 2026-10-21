import MarketingLayout from '~/layouts/marketing'

export default function ServerError() {
  return (
    <main className="home">
      <article className="prose-card">
        <div className="pc-top">
          <span className="pc-status mono tag" style={{ color: 'var(--error)' }}>
            <span className="dot" /> 500
          </span>
        </div>
        <h1 className="pc-lead">
          <span>Something broke.</span>
          <em>The server hit an unexpected error.</em>
        </h1>
        <p className="pc-para">
          Try again in a moment. If the problem persists, check the server logs for the underlying
          exception.
        </p>
      </article>
    </main>
  )
}

ServerError.layout = [MarketingLayout]
