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
  timer: NodeJS.Timeout
}

const FAILURE_DEADLINE_MS = 10_000

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
  let processError: Error | undefined
  let exit: WorkerExit | undefined
  let resolveExit: ((value: WorkerExit) => void) | undefined
  let rejectExit: ((error: Error) => void) | undefined
  let exitTimer: NodeJS.Timeout | undefined

  function rejectWaiters(error: Error) {
    for (const [type, waiters] of messageWaiters) {
      for (const waiter of waiters) waiter.reject(error)
      messageWaiters.delete(type)
    }
  }

  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  child.on('message', (value: unknown) => {
    const message = value as OutboxWorkerMessage
    if (message.type === 'error') {
      workerError = new Error(message.message)
      rejectWaiters(workerError)
      return
    }

    const waiter = messageWaiters.get(message.type)?.shift()
    if (waiter) waiter.resolve(message)
    else pendingMessages.push(message)
  })
  child.on('error', (error) => {
    processError = new Error(`Worker process failed: ${error.message}${stderr}`)
    workerError = processError
    rejectWaiters(workerError)
    if (exitTimer) clearTimeout(exitTimer)
    rejectExit?.(processError)
    resolveExit = undefined
    rejectExit = undefined
  })
  child.on('exit', (code, signal) => {
    exit = { code, signal }
    if (exitTimer) clearTimeout(exitTimer)
    resolveExit?.(exit)
    resolveExit = undefined
    rejectExit = undefined
    rejectWaiters(workerError ?? new Error(`Worker exited before sending a message: ${stderr}`))
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
      return new Promise<Extract<OutboxWorkerMessage, { type: T }>>((resolve, reject) => {
        const waiters = messageWaiters.get(type) ?? []
        const waiter: Waiter = {
          resolve: (message) => {
            clearTimeout(waiter.timer)
            resolve(message as Extract<OutboxWorkerMessage, { type: T }>)
          },
          reject: (error) => {
            clearTimeout(waiter.timer)
            reject(error)
          },
          timer: setTimeout(() => {
            const remaining = messageWaiters.get(type)?.filter((entry) => entry !== waiter) ?? []
            if (remaining.length) messageWaiters.set(type, remaining)
            else messageWaiters.delete(type)
            waiter.reject(new Error(`Timed out waiting for worker message ${type}: ${stderr}`))
          }, FAILURE_DEADLINE_MS),
        }
        waiters.push(waiter)
        messageWaiters.set(type, waiters)
      })
    },
    waitForExit() {
      if (exit) return Promise.resolve(exit)
      if (processError) return Promise.reject(processError)
      return new Promise((resolve, reject) => {
        resolveExit = resolve
        rejectExit = reject
        exitTimer = setTimeout(() => {
          resolveExit = undefined
          rejectExit = undefined
          reject(new Error(`Timed out waiting for worker exit: ${stderr}`))
        }, FAILURE_DEADLINE_MS)
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
