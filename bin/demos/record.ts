// Records each feature demo against a running demo app and writes one asciicast v2 file per scenario.
// Usage: node record.ts <app-dir> <out-dir> [scenario ...]
import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Cast, fit } from './cast.js'
import type { HttpOptions } from './scenarios.js'
import { createScenarios } from './scenarios.js'

const base = 'localhost:3333'
const password = 'hunter2hunter2'

/** Long secrets are shortened on screen; the real values are still sent. */
const shorten = (text: string) =>
  text
    .replace(/(oat_[\w-]{2})[\w.-]{20,}/g, '$1…')
    .replace(
      /(\/(?:password-reset|email-verification|invitations|email-change|magic-link)\/)([\w-]{6})[\w-]+/g,
      '$1$2…'
    )
    .replace(/("(?:token|verifier|clientChallenge)":")([\w.-]{6})[\w.-]{10,}"/g, '$1$2…"')

// ---- app process -------------------------------------------------------------------------------

let server: ReturnType<typeof spawn> | undefined
let log = ''
let appDir = ''
async function startServer() {
  log = ''
  server = spawn('node', ['ace', 'serve'], {
    cwd: appDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const child = server
  server.stdout!.on('data', (d) => (log += d))
  server.stderr!.on('data', (d) => (log += d))
  const outcome = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (!log.includes('started HTTP server'))
        reject(new Error(`server exited before readiness (${signal ?? code}):\n${log}`))
      else resolve()
    })
  })
  for (let i = 0; i < 80 && !log.includes('started HTTP server'); i++) {
    if (child.exitCode !== null || child.signalCode !== null) break
    await Promise.race([sleep(250), outcome])
  }
  if (log.includes('started HTTP server')) return
  if (!log.includes('started HTTP server')) throw new Error(`server did not start:\n${log}`)
}

const defaultSignal = (pid: number, signal: NodeJS.Signals | 0) => process.kill(-pid, signal)
const gone = (pid: number, signal: typeof defaultSignal = defaultSignal) => {
  try {
    signal(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

async function waitForGroupExit(
  pid: number,
  timeout: number,
  signal: typeof defaultSignal = defaultSignal
) {
  const deadline = Date.now() + timeout
  while (!gone(pid, signal) && Date.now() < deadline) await sleep(25)
  return gone(pid, signal)
}

function signalGroup(
  pid: number,
  signal: NodeJS.Signals,
  send: typeof defaultSignal = defaultSignal
) {
  try {
    send(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export async function stopServer(
  child: ChildProcess | undefined = server,
  force = false,
  operations: {
    signal?: typeof defaultSignal
    wait?: typeof waitForGroupExit
    close?: typeof waitForClose
  } = {}
) {
  if (!child?.pid) return
  const send = operations.signal ?? defaultSignal
  const wait = operations.wait ?? waitForGroupExit
  const close = operations.close ?? waitForClose
  const failures: Error[] = []
  try {
    if (!force) {
      signalGroup(child.pid, 'SIGTERM', send)
      if (!(await wait(child.pid, 5000, send))) force = true
    }
    if (force) {
      signalGroup(child.pid, 'SIGKILL', send)
      const reapDeadline = Date.now() + 5000
      if (!(await wait(child.pid, reapDeadline - Date.now(), send)))
        throw new Error(`owned server process group ${child.pid} did not exit after SIGKILL`)
      await close(child, Math.max(1, reapDeadline - Date.now()))
    } else {
      await close(child, 5000)
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)))
  } finally {
    if (server === child) server = undefined
  }
  if (failures.length)
    throw new AggregateError(failures, 'failed to clean up owned server process group')
}

function waitForClose(child: ChildProcess, timeout: number) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('owned server child did not close after process-group exit')),
      timeout
    )
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

export function recordingFailure(primary: unknown, cleanupErrors: Error[]) {
  if (primary && cleanupErrors.length) {
    const errors = [
      primary instanceof Error ? primary : new Error(String(primary)),
      ...cleanupErrors,
    ]
    return new AggregateError(errors, 'recording failed and cleanup also failed')
  }
  if (primary) return primary instanceof Error ? primary : new Error(String(primary))
  if (cleanupErrors.length) return new AggregateError(cleanupErrors, 'recording cleanup failed')
  return undefined
}
const ace = (...args: string[]) =>
  execFileSync('node', ['ace', ...args], { cwd: appDir, encoding: 'utf8' })

// ---- HTTP --------------------------------------------------------------------------------------

/** Runs curl for real and returns { status, body }. */
function curl(method: string, path: string | undefined, { body, token }: HttpOptions = {}) {
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
function http(
  cast: Cast,
  method: string,
  path: string | undefined,
  { body, token, tokenName = 'TOKEN' }: HttpOptions & { tokenName?: string } = {}
) {
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
async function nextMail(to: string) {
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
async function showMail(cast: Cast, to: string) {
  const mail = await nextMail(to)
  const [first] = mail.split('\n')
  const link = mail.match(/https?:\/\/\S+/)?.[0]
  cast.print(`\x1b[36m${first.replace('[account-kit] ', '[log] ')}\x1b[0m`, 0.6)
  if (link) cast.print(`\x1b[36m      ${shorten(link)}\x1b[0m`, 0.2)
  return link ? new URL(link).pathname : undefined
}

// ---- quiet setup -------------------------------------------------------------------------------

/** Creates a verified account off screen and returns a bearer token for it. */
async function verifiedUser(email: string) {
  curl('POST', '/api/auth/signup', { body: { email, password, passwordConfirmation: password } })
  const mail = await nextMail(email)
  const path = new URL(mail.match(/https?:\/\/\S+/)![0]).pathname
  curl('POST', path, { body: { password, passwordConfirmation: password } })
  return curl('POST', '/api/auth/login', { body: { email, password } }).body.token
}

// ---- scenarios ---------------------------------------------------------------------------------

// ---- run ---------------------------------------------------------------------------------------

const scenarios: Record<string, (cast: Cast) => Promise<void>> = createScenarios({
  ace,
  http,
  curl,
  showMail,
  skipMail,
  verifiedUser,
  password,
})

async function main() {
  const [app, outDir, ...only] = process.argv.slice(2)
  if (!app || !outDir) throw new Error('Usage: node record.ts <app-dir> <out-dir> [scenario ...]')
  appDir = app
  let firstSignal: NodeJS.Signals | undefined
  let forceCleanup = false
  let cleanupPromise: Promise<void> | undefined
  const cleanupErrors: Error[] = []
  const beginCleanup = () => {
    if (!server || cleanupPromise) return
    cleanupPromise = stopServer(server, forceCleanup).catch((error: unknown) => {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)))
    })
  }
  let resolveInterrupted!: () => void
  const interrupted = new Promise<void>((resolve) => (resolveInterrupted = resolve))
  const handleSignal = (signal: NodeJS.Signals) => {
    if (!firstSignal) {
      firstSignal = signal
      resolveInterrupted()
      beginCleanup()
      return
    }
    forceCleanup = true
    if (server?.pid) {
      try {
        signalGroup(server.pid, 'SIGKILL')
      } catch (error) {
        console.error(`Unable to escalate owned server cleanup: ${String(error)}`)
      }
    }
  }
  const onInt = () => handleSignal('SIGINT')
  const onTerm = () => handleSignal('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)

  let primary: unknown
  try {
    mkdirSync(outDir, { recursive: true })
    const selected = only.length ? only : Object.keys(scenarios)
    for (const name of selected) {
      if (firstSignal) break
      ace('migration:fresh', '--force')
      if (firstSignal) break
      mailSeen = 0
      await Promise.race([startServer(), interrupted])
      if (firstSignal) break
      const cast = new Cast()
      const recording = scenarios[name](cast)
      await Promise.race([recording, interrupted])
      if (firstSignal) {
        await recording.catch(() => undefined)
        break
      }
      cast.emit('', 2.5)
      cast.save(join(outDir, `${name}.cast`), `Account Kit: ${name}`)
      console.log(`${name}: ${cast.t.toFixed(1)} s`)
      await stopServer(server, forceCleanup)
    }
  } catch (error) {
    primary = error
  } finally {
    beginCleanup()
    await cleanupPromise
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }

  const failure = recordingFailure(primary, cleanupErrors)
  if (failure) console.error(failure)
  if (firstSignal === 'SIGINT') return 130
  if (firstSignal === 'SIGTERM') return 143
  return primary || cleanupErrors.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
