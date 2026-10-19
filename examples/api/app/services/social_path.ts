/** True for the HTTP paths that run social sign-in, linking, and sign-in method listing. */
export function isSocialPath(url: string) {
  const path = url.split('?', 1)[0]
  return (
    path.startsWith('/api/v1/auth/oauth/') ||
    path.startsWith('/api/v1/account/social/') ||
    path === '/api/v1/account/methods' ||
    path.startsWith('/api/v1/auth/social-verification/')
  )
}
