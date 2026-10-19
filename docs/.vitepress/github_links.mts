import { posix } from 'node:path'

export const repository = 'https://github.com/Kevinjohn/oss-adonisjs-account-kit'

/**
 * Pages link to files outside docs/ (examples, source, changelog) and to maintainer records that
 * the site leaves out. Point those links at GitHub instead of reporting them as dead.
 */
export function githubLinks(md: any) {
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
