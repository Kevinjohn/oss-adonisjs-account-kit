import { defineConfig } from 'vitepress'
import { githubLinks, repository } from './github_links.mjs'
import { nav, sidebar } from './navigation.mjs'

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
    nav,
    sidebar,
  },
})
