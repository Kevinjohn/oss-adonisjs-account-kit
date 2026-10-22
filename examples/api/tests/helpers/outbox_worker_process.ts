import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type OutboxWorkerMessage =
  | { type: 'ready' }
  | { type: 'delivery_accepted'; operationId: string }
  | { type: 'completed'; delivered: number }
  | { type: 'error'; message: string }

type WorkerMode = 'interrupt_after_delivery' | 'complete'
type WorkerMessageType = OutboxWorkerMessage['type']
type WorkerExit = { code: number | null; signal: NodeJS.Signals | null }
type Waiter = {
  resolve(message: OutboxWorkerMessage): void
  reject(error: Error): void
}

export type OutboxWorkerProcess = {
  child: ChildProcess
  waitFor<T extends WorkerMessageType>(type: T): Promise<Extract<OutboxWorkerMessage, { type: T }>>
  waitForExit(): Promise<WorkerExit>
  kill(): Promise<void>
}

/** Start a fresh Adonis process that drains the API example's existing outbox. */
export function startOutboxWorkerProcess(mode: WorkerMode): OutboxWorkerProcess {
  const child = fork(fileURLToPath(new URL('./outbox_worker.ts', import.meta.url)), [mode], {
    cwd: process.cwd(),
    execArgv: ['--import=@poppinss/ts-exec', '--enable-source-maps'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const pendingMessages: OutboxWorkerMessage[] = []
  const messageWaiters = new Map<WorkerMessageType, Waiter[]>()
  let stderr = ''
  let workerError: Error | undefined
  let exit: WorkerExit | undefined
  let resolveExit: ((value: WorkerExit) => void) | undefined

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('message', (value: unknown) => {
    const message = value as OutboxWorkerMessage
    if (message.type === 'error') {
      workerError = new Error(message.message)
      for (const waiters of messageWaiters.values()) {
        for (const waiter of waiters) waiter.reject(workerError)
      }
      messageWaiters.clear()
      return
    }

    const waiter = messageWaiters.get(message.type)?.shift()
    if (waiter) waiter.resolve(message)
    else pendingMessages.push(message)
  })
  child.on('exit', (code, signal) => {
    exit = { code, signal }
    resolveExit?.(exit)
    for (const waiters of messageWaiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(workerError ?? new Error(`Worker exited before sending a message: ${stderr}`))
      }
    }
    messageWaiters.clear()
  })

  const worker: OutboxWorkerProcess = {
    child,
    waitFor<T extends WorkerMessageType>(type: T) {
      const index = pendingMessages.findIndex((message) => message.type === type)
      if (index >= 0)
        return Promise.resolve(
          pendingMessages.splice(index, 1)[0] as Extract<OutboxWorkerMessage, { type: T }>
        )
      if (workerError) return Promise.reject(workerError)
      if (exit) return Promise.reject(new Error(`Worker exited before ${type}: ${stderr}`))
      return new Promise((resolve, reject) => {
        const waiters = messageWaiters.get(type) ?? []
        waiters.push({
          resolve: (message) => resolve(message as Extract<OutboxWorkerMessage, { type: T }>),
          reject,
        })
        messageWaiters.set(type, waiters)
      })
    },
    waitForExit() {
      if (exit) return Promise.resolve(exit)
      return new Promise((resolve) => {
        resolveExit = resolve
      })
    },
    async kill() {
      if (!exit) {
        child.kill('SIGKILL')
        await worker.waitForExit()
      }
    },
  }
  return worker
}
