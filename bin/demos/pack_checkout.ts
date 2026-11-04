// Builds and packs this checkout so a demo app runs the package as it is here, not the release.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })

export type PackedCheckout = {
  archivePath: string
  sha256: string
  packageName: string
  packageVersion: string
}

function packageMetadata(archivePath: string) {
  const archive = gunzipSync(readFileSync(archivePath))
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const path = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(),
      8
    )
    const contentStart = offset + 512
    if (path === 'package/package.json') {
      const metadata = JSON.parse(
        archive.subarray(contentStart, contentStart + size).toString('utf8')
      ) as {
        name?: unknown
        version?: unknown
      }
      if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string')
        throw new Error('packed package metadata must include a name and version')
      return { packageName: metadata.name, packageVersion: metadata.version }
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  throw new Error('selected archive has no package/package.json')
}

/** Builds this checkout and records the metadata for its uniquely owned archive. */
export function packCheckout(archivePath: string): PackedCheckout {
  archivePath = resolve(archivePath)
  mkdirSync(dirname(archivePath), { recursive: true })
  run('pnpm', ['build'], repoRoot)
  run('pnpm', ['--config.verify-deps-before-run=false', 'pack', '--out', archivePath], repoRoot)
  const metadata = packageMetadata(archivePath)
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  const result = { archivePath, sha256, ...metadata }
  writeFileSync(
    join(dirname(archivePath), 'candidate.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
  return result
}
