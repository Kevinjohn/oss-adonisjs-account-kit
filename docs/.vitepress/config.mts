import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  srcExclude: ['maintainers/**'],
  rewrites: {
    'README.md': 'index.md',
    'reference/README.md': 'reference/index.md',
  },
  markdown: { config: githubLinks },
  transformPageData(pageData) {
    if (pageData.relativePath.startsWith('reference/api/')) {
      pageData.frontmatter.editLink = false
    }
  },
  async buildEnd({ srcDir, outDir }) {
    await mkdir(join(outDir, 'reference'), { recursive: true })
    await Promise.all(
      ['setup_choices.example.json', 'setup_choices.api.example.json'].map((filename) =>
        copyFile(join(srcDir, 'reference', filename), join(outDir, 'reference', filename))
      )
    )
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/docs/:path` },
    nav,
    sidebar,
  },
})
