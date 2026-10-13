/*
|--------------------------------------------------------------------------
| Configure hook
|--------------------------------------------------------------------------
|
| The configure hook is called when someone runs "node ace configure <package>"
| command. You are free to perform any operations inside this function to
| configure the package.
|
| To make things easier, you have access to the underlying "Configure"
| instance and you can use codemods to modify the source files.
|
*/

import { readFile, readdir } from 'node:fs/promises'
import type Configure from '@adonisjs/core/commands/configure'

const migrationNames = [
  'create_account_recovery_tokens',
  'create_account_invitations',
  'create_account_email_changes',
  'add_email_verified_at_to_users',
]

function report(command: Configure, status: 'created' | 'skipped', path: string) {
  command.logger.info(`${status === 'created' ? 'Created' : 'Skipped'} ${path}`)
}

export async function configure(command: Configure) {
  const codemods = await command.createCodemods()
  codemods.overwriteExisting = false
  const config = await codemods.makeUsingStub(command.stubsRoot, 'config/account_kit.stub', {
    config: { destination: command.app.makePath('config/account_kit.ts') },
  })
  report(
    command,
    config.status === 'skipped' ? 'skipped' : 'created',
    command.app.relativePath(config.destination)
  )

  const migrationsDirectory = command.app.makePath('database/migrations')
  let migrationFiles: string[] = []
  try {
    migrationFiles = await readdir(migrationsDirectory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const timestamp = Date.now()
  for (const [index, name] of migrationNames.entries()) {
    const pattern = new RegExp(`^.+_account_kit_${name}\\.ts$`)
    if (migrationFiles.some((filename) => pattern.test(filename))) {
      report(command, 'skipped', `database/migrations/*_account_kit_${name}.ts`)
      continue
    }

    const filename = `${timestamp + index}_account_kit_${name}.ts`
    const result = await codemods.makeUsingStub(command.stubsRoot, `migrations/${name}.stub`, {
      migration: { destination: command.app.makePath(`database/migrations/${filename}`) },
    })
    report(
      command,
      result.status === 'skipped' ? 'skipped' : 'created',
      command.app.relativePath(result.destination)
    )
    migrationFiles.push(filename)
  }

  const providerPath = 'adonisjs-account-kit/providers/account_kit_provider'
  const rcPath = command.app.makePath('adonisrc.ts')
  let providerWasRegistered = false
  try {
    const rcContents = await readFile(rcPath, 'utf8')
    providerWasRegistered = rcContents.includes(providerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await codemods.updateRcFile((rcFile) => rcFile.addProvider(providerPath))
  report(command, providerWasRegistered ? 'skipped' : 'created', 'adonisrc.ts provider')
}
