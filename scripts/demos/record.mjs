// Records each feature demo against a running demo app and writes one asciicast v2 file per scenario.
// Usage: node record.mjs <app-dir> <out-dir> [scenario ...]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Cast, fit } from './cast.mjs'
import { createScenarios } from './scenarios.mjs'

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
/** Process IDs listening on port 3333; clients connected to it are not included. */
const listeners = () =>
  execFileSync('bash', ['-c', 'lsof -ti tcp:3333 -sTCP:LISTEN || true'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

async function startServer() {
  if (listeners().length) throw new Error('Port 3333 is in use; stop that process first')
  log = ''
  server = spawn('node', ['ace', 'serve'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (d) => (log += d))
  server.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 80 && !log.includes('started HTTP server'); i++) await sleep(250)
  if (!log.includes('started HTTP server')) throw new Error(`server did not start:\n${log}`)
}
function stopServer() {
  server?.kill()
  // `ace serve` runs the HTTP server in a child process, so end whatever this run left listening.
  for (const pid of listeners()) {
    try {
      process.kill(Number(pid))
    } catch {}
  }
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

// ---- run ---------------------------------------------------------------------------------------

const scenarios = createScenarios({ ace, http, curl, showMail, skipMail, verifiedUser, password })

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
