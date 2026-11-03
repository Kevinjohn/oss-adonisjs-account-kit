/** Reconcile only the checked-out candidate's archive identity in an example lockfile. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: prepare_example_archive.ts <example directory>')
const archive = join(directory, 'vendor/kevinjohn-adonisjs-account-kit.tgz')
const manifest = JSON.parse(
  execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' })
)
if (
  manifest.name !== '@kevinjohn/adonisjs-account-kit' ||
  !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)
) {
  throw new Error('Expected an Account Kit candidate with a valid version')
}
for (const field of [
  'dependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
]) {
  if (typeof manifest[field] === 'boolean' || Object.keys(manifest[field] ?? {}).length) {
    throw new Error(`Candidate ${field} changed; regenerate example lockfiles deliberately`)
  }
}
if (Object.keys(manifest.engines ?? {}).join() !== 'node') {
  throw new Error('Candidate engines changed; regenerate example lockfiles deliberately')
}
const key = (name: string) => (name.startsWith('@') ? `'${name}'` : name)
let metadata = `    engines: {node: '${manifest.engines.node}'}\n`
metadata += '    peerDependencies:\n'
for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
  metadata += `      ${key(name)}: ${range}\n`
}
metadata += '    peerDependenciesMeta:\n'
for (const [name, options] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
  if (JSON.stringify(options) !== '{"optional":true}') {
    throw new Error('Candidate peer metadata changed; regenerate example lockfiles deliberately')
  }
  metadata += `      ${key(name)}:\n        optional: true\n`
}
const path = join(directory, 'pnpm-lock.yaml')
const lock = readFileSync(path, 'utf8')
const pattern = new RegExp(
  String.raw`^ {2}'@kevinjohn/adonisjs-account-kit@file:vendor\/kevinjohn-adonisjs-account-kit\.tgz':\n([\s\S]*?)(?=\n\n)`,
  'gm'
)
const matches = [...lock.matchAll(pattern)]
if (matches.length !== 1) throw new Error('Expected exactly one candidate package lock entry')
const entry = matches[0][0]
const identity = /^ {4}resolution:[\s\S]*?^ {4}version: [^\n]+\n/m
const pinnedMetadata = entry.replace(/^.*\n/, '').replace(identity, '')
const normalize = (value: string) =>
  value.replace(/^ {4}engines: \{ ?node: ('[^']*') ?\}$/m, '    engines: {node: $1}').trimEnd()
if (normalize(pinnedMetadata) !== normalize(metadata)) {
  throw new Error(
    'Candidate dependency or peer metadata changed; regenerate example lockfiles deliberately'
  )
}
if ((entry.match(/integrity: sha512-[\w+/=]+/g) ?? []).length !== 1 || !identity.test(entry)) {
  throw new Error('Unrecognized candidate archive lock entry')
}
const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`
if (
  (entry.match(/tarball: file:vendor\/kevinjohn-adonisjs-account-kit\.tgz(?=[,}\s])/g) ?? [])
    .length !== 1
) {
  throw new Error('Expected the candidate archive resolution path')
}
const updated = entry
  .replace(/integrity: sha512-[\w+/=]+/, `integrity: ${integrity}`)
  .replace(/^ {4}version: [^\n]+$/m, `    version: ${manifest.version}`)
writeFileSync(path, lock.replace(entry, updated))
console.log(`${directory}: candidate ${manifest.version}, ${integrity}`)
