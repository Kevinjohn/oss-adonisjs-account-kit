import { posix } from 'node:path'
import { defineConfig } from 'vitepress'

const repository = 'https://github.com/Kevinjohn/oss-adonisjs-account-kit'

/**
 * Pages link to files outside docs/ (examples, source, changelog) and to maintainer records that
 * the site leaves out. Point those links at GitHub instead of reporting them as dead.
 */
function githubLinks(md: any) {
  md.core.ruler.push('github_links', (state: any) => {
    const page: string = state.env.relativePath ?? ''
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue
        const href: string = token.attrGet('href') ?? ''
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) continue
        const [path, hash] = href.split('#')
        const target = posix.normalize(posix.join('docs', posix.dirname(page), path))
        if (!target.startsWith('docs/') || target.startsWith('docs/maintainers/'))
          token.attrSet('href', `${repository}/blob/main/${target}${hash ? `#${hash}` : ''}`)
      }
    }
  })
}

export default defineConfig({
  title: 'Account Kit',
  description:
    'Password reset, email verification, invitations and account management for AdonisJS',
  base: '/oss-adonisjs-account-kit/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['maintainers/**', 'reviews/**', 'PRD*.md'],
  rewrites: { 'README.md': 'index.md' },
  markdown: { config: githubLinks },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path` },
    nav: [
      { text: 'Get started', link: '/getting-started' },
      { text: 'Recipes', link: '/recipes/access-tokens' },
      { text: 'Reference', link: '/reference/errors' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: [
      { text: 'Tutorial', items: [{ text: 'Getting started', link: '/getting-started' }] },
      {
        text: 'How-to guides',
        items: [
          { text: 'Access tokens', link: '/recipes/access-tokens' },
          { text: 'Sessions', link: '/recipes/sessions' },
          { text: 'Inertia and React', link: '/recipes/inertia-react' },
          { text: 'Social sign-in', link: '/recipes/social-login' },
          { text: 'Magic-link sign-in', link: '/magic-link' },
          { text: 'Signed-in devices', link: '/signed-in-devices' },
          { text: 'Account export and deletion', link: '/account-data' },
          { text: 'Custom user model', link: '/recipes/custom-user-model' },
          { text: 'Custom table or ID type', link: '/custom-schema' },
          { text: 'Drizzle, Prisma and SQL users', link: '/adapters' },
          { text: 'Custom adapter', link: '/recipes/custom-adapter' },
          { text: 'Multi-tenant', link: '/recipes/multi-tenant' },
          { text: 'Email templates', link: '/recipes/email-templates' },
          { text: 'Development mail', link: '/recipes/development-mail' },
          { text: 'Testing', link: '/recipes/testing' },
          { text: 'Audit log', link: '/recipes/audit-log' },
          { text: 'Guided setup', link: '/setup' },
          { text: 'Upgrading a candidate', link: '/upgrade' },
          { text: 'Operations', link: '/operations' },
        ],
      },
      {
        text: 'Integration modes',
        items: [
          { text: 'Application-owned routes', link: '/application-owned-integration' },
          { text: 'Managed JSON routes', link: '/managed-http' },
          { text: 'Managed social routes', link: '/managed-social' },
          { text: 'Application-owned social', link: '/social-reference' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/api/' },
          { text: 'Usage', link: '/usage' },
          { text: 'Account operations', link: '/account-operations' },
          { text: 'Errors', link: '/reference/errors' },
          { text: 'Managed endpoints', link: '/reference/endpoints' },
          { text: 'Setup choices', link: '/reference/setup-choices' },
          { text: 'OpenAPI document', link: '/openapi' },
          { text: 'Notifications', link: '/notifications' },
          { text: 'Production requirements', link: '/reference/production-requirements' },
          { text: 'Compatibility', link: '/compatibility' },
          { text: 'Glossary', link: '/glossary' },
        ],
      },
      {
        text: 'Explanation',
        items: [
          { text: 'Security model', link: '/security' },
          { text: 'How setup works', link: '/how-setup-works' },
          { text: 'Production boundaries', link: '/production-boundaries' },
          { text: 'Authentication', link: '/authentication' },
          { text: 'Identity creation', link: '/identity-creation' },
          { text: 'Registration', link: '/registration' },
          { text: 'Social authentication', link: '/social-authentication' },
        ],
      },
    ],
  },
})
