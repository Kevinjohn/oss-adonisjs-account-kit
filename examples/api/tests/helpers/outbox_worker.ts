type WorkerMode = 'interrupt_after_delivery' | 'complete'
type WorkerApplication = {
  init(): Promise<unknown>
  boot(): Promise<unknown>
  terminate(): Promise<void>
}

async function run() {
  let app: WorkerApplication | undefined

  try {
    process.env.NODE_ENV = 'test'
    await import('reflect-metadata')
    const { Ignitor } = await import('@adonisjs/core')

    const APP_ROOT = new URL('../../', import.meta.url)
    const IMPORTER = (filePath: string) => {
      if (filePath.startsWith('./') || filePath.startsWith('../')) {
        return import(new URL(filePath, APP_ROOT).href)
      }
      return import(filePath)
    }

    const ignitor = new Ignitor(APP_ROOT, { importer: IMPORTER }).tap((application) => {
      application.booting(async () => {
        await import('#start/env')
      })
    })
    app = ignitor.createApp('console')
    await app.init()
    await app.boot()

    const mode = process.argv.at(-1) as WorkerMode
    const [{ dispatchAccountKitOutbox }, { notifications }] = await Promise.all([
      import('#services/account_kit_outbox'),
      import('#services/account_kit_notifications'),
    ])
    process.send?.({ type: 'ready' })

    const delivered = await dispatchAccountKitOutbox(
      100,
      async (operationId, operation, recipient) => {
        await notifications.deliverCredentialNotice(operationId, operation, recipient)
        process.send?.({ type: 'delivery_accepted', operationId })

        if (mode === 'interrupt_after_delivery') {
          await new Promise<void>((resolve) => {
            process.once('message', () => resolve())
          })
        }
      }
    )
    process.send?.({ type: 'completed', delivered })
  } catch (error: unknown) {
    process.send?.({
      type: 'error',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
    process.exitCode = 1
  } finally {
    try {
      await app?.terminate()
    } finally {
      if (process.connected) process.disconnect()
    }
  }
}

void run()
