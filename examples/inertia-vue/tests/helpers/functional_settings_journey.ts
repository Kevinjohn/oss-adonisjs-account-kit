/* eslint-disable @unicorn/no-await-expression-member -- Keep each HTTP response beside its assertion. */
import User from '#models/user'

export const origin = process.env.APP_URL!
export const currentPassword = 'OldPass123!'

export class BrowserSession {
  private cookies = new Map<string, string>()
  private version: string | undefined

  async request(path: string, form?: Record<string, string>) {
    const headers = new Headers({
      'cookie': [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      'x-inertia': 'true',
    })
    if (this.version) headers.set('x-inertia-version', this.version)
    if (form) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      headers.set('x-xsrf-token', decodeURIComponent(this.cookies.get('XSRF-TOKEN') ?? ''))
      headers.set('referer', new URL(path, origin).href)
    }
    const response = await fetch(new URL(path, origin), {
      method: form ? 'POST' : 'GET',
      headers,
      body: form ? new URLSearchParams(form) : undefined,
      redirect: 'manual',
    })
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=', 2)
      if (name) this.cookies.set(name, value ?? '')
    }
    return response
  }

  async login(user: User) {
    const page = await this.request('/login')
    this.version = ((await page.json()) as { version: string }).version
    const response = await this.request('/login', { email: user.email, password: currentPassword })
    // A refused login also answers 302, back to the form; only the dashboard means signed in.
    if (!response.headers.get('location')?.endsWith('/dashboard'))
      throw new Error(`Login for ${user.email} did not sign in`)
    return response
  }

  async props(path: string) {
    const response = await this.request(path)
    return {
      status: response.status,
      props: (await response.json()) as {
        props: {
          profile?: { fullName: string }
          user?: { id: number }
          valid?: boolean
          canRequestChange?: boolean
        }
      },
    }
  }
}
