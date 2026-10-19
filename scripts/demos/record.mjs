// Records each feature demo against a running demo app and writes one asciicast v2 file per scenario.
// Usage: node record.mjs <app-dir> <out-dir> [scenario ...]
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cast, fit } from './cast.mjs'

const [appDir, outDir, ...only] = process.argv.slice(2)
if (!appDir || !outDir) throw new Error('Usage: node record.mjs <app-dir> <out-dir> [scenario ...]')
const base = 'localhost:3333'
const password = 'hunter2hunter2'

/** Long secrets are shortened on screen; the real values are still sent. */
const shorten = (text) =>
  text
    .replace(/(oat_[\w-]{2})[\w.-]{20,}/g, '$1…')
    .replace(
      /(\/(?:password-reset|email-verification|invitations|email-change|magic-link)\/)([\w-]{6})[\w-]+/g,
      '$1$2…'
    )
    .replace(/("(?:token|verifier|clientChallenge)":")([\w.-]{6})[\w.-]{10,}"/g, '$1$2…"')

// ---- app process -------------------------------------------------------------------------------

let server
let log = ''
async function startServer() {
  log = ''
  server = spawn('node', ['ace', 'serve'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => (log += d))
  server.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 80 && !log.includes('started HTTP server'); i++) await sleep(250)
  if (!log.includes('started HTTP server')) throw new Error(`server did not start:\n${log}`)
}
function stopServer() {
  server?.kill()
  try {
    execFileSync('bash', ['-c', 'lsof -ti :3333 | xargs kill 2>/dev/null || true'])
  } catch {}
}
const ace = (...args) => execFileSync('node', ['ace', ...args], { cwd: appDir, encoding: 'utf8' })

// ---- HTTP --------------------------------------------------------------------------------------

/** Runs curl for real and returns { status, body }. */
function curl(method, path, { body, token } = {}) {
  const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', method, `${base}${path}`]
  if (body) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body))
  if (token) args.push('-H', `authorization: Bearer ${token}`)
  const out = execFileSync('curl', args, { encoding: 'utf8' })
  const at = out.lastIndexOf('\n')
  const raw = out.slice(0, at)
  let json
  try {
    json = raw ? JSON.parse(raw) : undefined
  } catch {
    json = raw
  }
  return { status: Number(out.slice(at + 1)), body: json, raw }
}

/** Shows the command a reader would type, runs it, and prints the status and body. */
function http(cast, method, path, { body, token, tokenName = 'TOKEN' } = {}) {
  let shown = `curl -X ${method} :3333${path}`
  if (token) shown += ` -H "authorization: Bearer $${tokenName}"`
  if (body) shown += ` -d '${shorten(JSON.stringify(body))}'`
  cast.type(fit(shorten(shown)))
  const result = curl(method, path, { body, token })
  const colour = result.status < 300 ? 32 : result.status < 500 ? 33 : 31
  cast.print(`\x1b[${colour}mHTTP ${result.status}\x1b[0m ${shorten(result.raw)}`)
  return result
}

// ---- mail --------------------------------------------------------------------------------------

let mailSeen = 0
async function nextMail(to) {
  for (let i = 0; i < 40; i++) {
    const mails = log
      .split('\n')
      .filter((line) => line.includes('[account-kit] mail to'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))).msg)
    const found = mails
      .slice(mailSeen)
      .findIndex((m) => m.startsWith(`[account-kit] mail to ${to}:`))
    if (found !== -1) {
      mailSeen += found + 1
      return mails[mailSeen - 1]
    }
    await sleep(100)
  }
  throw new Error(`no mail to ${to}`)
}
function skipMail() {
  mailSeen = log.split('\n').filter((line) => line.includes('[account-kit] mail to')).length
}

/** Prints the mail's subject and link as the dev server log shows them, and returns the link. */
async function showMail(cast, to) {
  const mail = await nextMail(to)
  const [first] = mail.split('\n')
  const link = mail.match(/https?:\/\/\S+/)?.[0]
  cast.print(`\x1b[36m${first.replace('[account-kit] ', '[log] ')}\x1b[0m`, 0.6)
  if (link) cast.print(`\x1b[36m      ${shorten(link)}\x1b[0m`, 0.2)
  return link ? new URL(link).pathname : undefined
}

// ---- quiet setup -------------------------------------------------------------------------------

/** Creates a verified account off screen and returns a bearer token for it. */
async function verifiedUser(email) {
  curl('POST', '/api/auth/signup', { body: { email, password, passwordConfirmation: password } })
  const mail = await nextMail(email)
  const path = new URL(mail.match(/https?:\/\/\S+/)[0]).pathname
  curl('POST', path, { body: { password, passwordConfirmation: password } })
  return curl('POST', '/api/auth/login', { body: { email, password } }).body.token
}

// ---- scenarios ---------------------------------------------------------------------------------

const scenarios = {
  async 'doctor'(cast) {
    cast.comment('check the install: config, limiter, APP_URL and tables')
    cast.type('node ace account-kit:doctor')
    cast.print(ace('account-kit:doctor').replaceAll('[ success ]', '\x1b[32m[ success ]\x1b[0m'))
  },

  async 'password-reset'(cast) {
    await verifiedUser('ada@example.com')
    skipMail()
    cast.comment('request a reset: the same answer whether or not the account exists')
    http(cast, 'POST', '/api/auth/password-reset', { body: { email: 'ada@example.com' } })
    http(cast, 'POST', '/api/auth/password-reset', { body: { email: 'nobody@example.com' } })
    cast.comment('only the real account gets an email')
    const path = await showMail(cast, 'ada@example.com')
    cast.comment('use the link once')
    const next = { password: 'a new long password', passwordConfirmation: 'a new long password' }
    http(cast, 'POST', path, { body: next })
    cast.comment('a second use is rejected')
    http(cast, 'POST', path, { body: next })
  },

  async 'signup-verification'(cast) {
    cast.comment('sign up: the account starts unverified')
    http(cast, 'POST', '/api/auth/signup', {
      body: { email: 'grace@example.com', password, passwordConfirmation: password },
    })
    const path = await showMail(cast, 'grace@example.com')
    cast.comment('open the link to confirm the address')
    http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
    cast.comment('signing in now gives an active account')
    http(cast, 'POST', '/api/auth/login', { body: { email: 'grace@example.com', password } })
  },

  async 'invitations'(cast) {
    const token = await verifiedUser('owner@example.com')
    skipMail()
    cast.comment('invite a teammate with a role')
    http(cast, 'POST', '/api/account/invitations', {
      token,
      body: { email: 'lin@example.com', role: 'editor' },
    })
    const path = await showMail(cast, 'lin@example.com')
    cast.comment('the invitee checks the link, then sets a password')
    http(cast, 'GET', path)
    http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
    cast.comment('the link works once')
    http(cast, 'POST', path, { body: { password, passwordConfirmation: password } })
  },

  async 'email-change'(cast) {
    const token = await verifiedUser('mo@example.com')
    skipMail()
    cast.comment('change email: confirm with the current password')
    http(cast, 'PATCH', '/api/account/profile', {
      token,
      body: { email: 'mo@new.example.com', currentPassword: password },
    })
    cast.comment('the new address gets a confirmation link')
    const path = await showMail(cast, 'mo@new.example.com')
    http(cast, 'POST', path)
    cast.comment('the old address is told about the change')
    await showMail(cast, 'mo@example.com')
  },

  async 'password-change'(cast) {
    await verifiedUser('kai@example.com')
    cast.comment('signed in on two devices')
    const laptop = http(cast, 'POST', '/api/auth/login', {
      body: { email: 'kai@example.com', password },
    }).body.token
    const phone = curl('POST', '/api/auth/login', { body: { email: 'kai@example.com', password } })
      .body.token
    cast.comment('change the password from the laptop')
    http(cast, 'POST', '/api/account/password', {
      token: laptop,
      tokenName: 'LAPTOP',
      body: {
        currentPassword: password,
        newPassword: 'another long password',
        newPasswordConfirmation: 'another long password',
      },
    })
    cast.comment('the phone is signed out')
    http(cast, 'GET', '/api/account/profile', { token: phone, tokenName: 'PHONE' })
  },

  async 'login-throttling'(cast) {
    await verifiedUser('sam@example.com')
    cast.comment('wrong passwords get one generic error')
    for (let i = 0; i < 5; i++)
      http(cast, 'POST', '/api/auth/login', {
        body: { email: 'sam@example.com', password: 'guess' + i },
      })
    cast.comment('then the address is blocked for a while, even with the right password')
    http(cast, 'POST', '/api/auth/login', { body: { email: 'sam@example.com', password } })
  },

  async 'magic-link'(cast) {
    await verifiedUser('ivy@example.com')
    skipMail()
    const verifier = randomBytes(32).toString('base64url')
    const clientChallenge = createHash('sha256').update(verifier).digest('base64url')
    cast.comment('the app keeps a secret verifier and sends only its hash')
    http(cast, 'POST', '/api/auth/magic-link', {
      body: { email: 'ivy@example.com', clientChallenge },
    })
    const path = await showMail(cast, 'ivy@example.com')
    cast.comment('opened somewhere else, without the right verifier: it fails and is used up')
    http(cast, 'POST', path, { body: { verifier: randomBytes(32).toString('base64url') } })
    cast.comment('ask again; the app that asked signs in')
    http(cast, 'POST', '/api/auth/magic-link', {
      body: { email: 'ivy@example.com', clientChallenge },
    })
    const second = await showMail(cast, 'ivy@example.com')
    http(cast, 'POST', second, { body: { verifier } })
  },

  async 'devices'(cast) {
    await verifiedUser('noor@example.com')
    const tokens = []
    for (let i = 0; i < 2; i++)
      tokens.push(
        curl('POST', '/api/auth/login', { body: { email: 'noor@example.com', password } }).body
          .token
      )
    cast.comment('list where this account is signed in')
    http(cast, 'GET', '/api/account/sessions', { token: tokens[0] })
    cast.comment('sign out every other device')
    http(cast, 'POST', '/api/account/sessions/revoke-others', { token: tokens[0] })
    http(cast, 'GET', '/api/account/sessions', { token: tokens[0] })
  },

  async 'export-deletion'(cast) {
    const token = await verifiedUser('eli@example.com')
    cast.comment('download your data; re-enter the password first')
    http(cast, 'POST', '/api/account/export', { token, body: { currentPassword: password } })
    cast.comment('delete the account')
    http(cast, 'DELETE', '/api/account', { token, body: { currentPassword: password } })
    await showMail(cast, 'eli@example.com')
    cast.comment('the account is gone')
    http(cast, 'POST', '/api/auth/login', { body: { email: 'eli@example.com', password } })
  },

  async 'operator-commands'(cast) {
    await verifiedUser('support@example.com')
    cast.comment('a reset link from a trusted shell, for support cases')
    cast.type('node ace account-kit:reset-link support@example.com')
    const output = ace('account-kit:reset-link', 'support@example.com').trim().split('\n')
    for (const line of output) {
      const entry = line.startsWith('{"level"') ? JSON.parse(line).msg : line
      const mail = entry.startsWith('[account-kit] mail to')
      const shown = mail ? entry.split('\n')[0].replace('[account-kit] ', '[log] ') : entry
      cast.print(mail ? `\x1b[36m${shown}\x1b[0m` : shown)
    }
    cast.comment('delete expired tokens; schedule this')
    cast.type('node ace account-kit:prune')
    cast.print(ace('account-kit:prune'))
  },
}

// ---- run ---------------------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true })
const selected = only.length ? only : Object.keys(scenarios)
// Each scenario starts from an empty database, which also empties the limiter store.
for (const name of selected) {
  ace('migration:fresh', '--force')
  mailSeen = 0
  await startServer()
  try {
    const cast = new Cast()
    await scenarios[name](cast)
    cast.emit('', 2.5)
    cast.save(join(outDir, `${name}.cast`), `Account Kit: ${name}`)
    console.log(`${name}: ${cast.t.toFixed(1)} s`)
  } finally {
    stopServer()
  }
}
