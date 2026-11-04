// Executable template for the managed PostgreSQL service fixture.
export const tools = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const root = path.dirname(path.dirname(process.argv[1]))
const name = path.basename(process.argv[1])
const args = process.argv.slice(2)
const data = path.join(root, 'tmp/pg16')
const pidfile = path.join(data, 'postmaster.pid')
const marker = (name) => fs.writeFileSync(path.join(root, name), '')
const config = JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'))
const alive = (pid) => { try { process.kill(Number(pid), 0); return true } catch { return false } }
const pause = async (name) => {
  marker(name + '-ready')
  while (!fs.existsSync(path.join(root, name + '-release'))) await new Promise((resolve) => setTimeout(resolve, 20))
}
const exit = (code) => process.exit(code)
async function main() {
  if (name === 'brew') {
    if (config.noBrew) exit(1)
    console.log(root); return
  }
  if (name === 'ps') {
    const pid = args[args.indexOf('-p') + 1]
    if (!alive(pid) || config.uninspectable) exit(1)
    const record = fs.existsSync(pidfile) ? fs.readFileSync(pidfile, 'utf8').split('\\n') : []
    if (record[0] !== pid || config.foreignExecutable) { console.log('/usr/bin/unrelated'); return }
    const executable = path.join(root, 'bin/postgres')
    const command = executable + ' -D ' + (config.foreignArgs || data) + ' -p ' + record[3] + ' -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off'
    console.log(args.includes('comm=') ? config.platform === 'linux' ? 'postgres' : executable : config.backendTitle ? 'postgres: account_kit backend' : command + (config.extraArgs || ''))
    return
  }
  if (name === 'pnpm') {
    fs.appendFileSync(path.join(root, 'runner-pids'), String(process.pid) + '\\n')
    fs.writeFileSync(path.join(root, 'test-environment.json'), JSON.stringify({ env: process.env, args, cwd: process.cwd() }))
    if (config.testHold) {
      const childCode = config.ignoreTerm
        ? 'process.on("SIGTERM", () => require("node:fs").writeFileSync(' + JSON.stringify(path.join(root, 'descendant-term-seen')) + ', "")); require("node:fs").writeFileSync(' + JSON.stringify(path.join(root, 'descendant-ready')) + ', ""); setInterval(() => {}, 1000)'
        : 'setInterval(() => {}, 1000)'
      const child = spawn(process.execPath, ['-e', childCode], { stdio: 'ignore' })
      fs.writeFileSync(path.join(root, 'descendant'), String(child.pid))
      if (config.ignoreTerm) while (!fs.existsSync(path.join(root, 'descendant-ready'))) await new Promise((resolve) => setTimeout(resolve, 20))
      marker('test-ready')
      await new Promise(() => {})
    }
    exit(config.testExit || 0)
  }
  if (name === 'postgres') { setInterval(() => {}, 1000); return }
  if (name === 'pg_ctl' && args[0] === '--version') { console.log('pg_ctl (PostgreSQL) ' + (config.version || '16.15')); return }
  if (Object.keys(process.env).some((key) => key.startsWith('PG') || key.startsWith('DB_'))) exit(91)
  fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({ name, args }) + '\\n')
  if (name === 'initdb') {
    fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, 'PG_VERSION'), '16\\n'); return
  }
  if (name === 'pg_ctl') {
    const action = args[args.length - 1]
    if (action === 'status') {
      if (config.status !== undefined) exit(config.status)
      if (!fs.existsSync(data)) exit(4)
      if (!fs.existsSync(pidfile)) exit(3)
      exit(alive(fs.readFileSync(pidfile, 'utf8').split('\\n')[0]) ? 0 : 3)
    }
    if (action === 'start') {
      const child = spawn(path.join(root, 'bin/postgres'), [], { cwd: config.postgresCwd || data, detached: true, stdio: 'ignore' }); child.unref()
      fs.writeFileSync(path.join(root, 'server-pid'), String(child.pid))
      const options = args[args.indexOf('-o') + 1]
      const port = options.split(' ')[1]
      fs.writeFileSync(pidfile, child.pid + '\\n' + data + '\\n0\\n' + port + '\\n')
      if (config.startHold) await pause('start')
      exit(config.startFail || 0)
    }
    if (action === 'stop') {
      if (config.stopHold) await pause('stop')
      if (config.stopFail) exit(config.stopFail)
      const pid = fs.readFileSync(pidfile, 'utf8').split('\\n')[0]
      process.kill(Number(pid), 'SIGTERM'); fs.unlinkSync(pidfile); marker('stopped'); return
    }
  }
  if (name === 'psql') {
    if (config.queryFail) exit(config.queryFail)
    if (fs.existsSync(path.join(root, 'database'))) console.log('1')
    return
  }
  if (name === 'createdb') {
    if (config.createdbFail) exit(config.createdbFail)
    marker('database'); return
  }
  if (name === 'pg_isready') exit(config.readiness || 0)
}
main().catch((error) => { console.error(error); process.exitCode = 99 })
`
