import MarketingLayout from '~/layouts/marketing'

export default function NotFound() {
  return (
    <main className="home">
      <article className="prose-card">
        <div className="pc-top">
          <span className="pc-status mono tag" style={{ color: 'var(--subtle)' }}>
            <span className="dot" /> 404
          </span>
        </div>
        <h1 className="pc-lead">
          <span>Not found.</span>
          <em>That route hasn&apos;t been built yet.</em>
        </h1>
        <p className="pc-para">
          The page you tried to reach doesn&apos;t exist. Check the URL or head back home.
        </p>
      </article>
    </main>
  )
}

NotFound.layout = [MarketingLayout]
