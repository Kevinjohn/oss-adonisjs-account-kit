import type { LifecycleEvent } from 'adonisjs-account-kit'

export type Notice = { kind: string; recipient: string; value: string }

export const notifications = {
  events: [] as Notice[],
  lifecycleEvents: [] as LifecycleEvent[],
  failRecovery: false,
  failPasswordReset: false,
  failPasswordChanged: false,
  failLifecycle: false,
  crashAfterOutboxSend: false,
  deliveredOperationIds: new Set<string>(),
  async send(kind: string, recipient: string, value: string) {
    if (kind === 'recovery' && this.failRecovery) throw new Error('temporary delivery outage')
    if (kind === 'passwordReset' && this.failPasswordReset) {
      throw new Error('temporary password notice outage')
    }
    this.events.push({ kind, recipient, value })
  },
  async deliverCredentialNotice(operationId: string, operation: string, recipient: string) {
    if (operation === 'password_reset' && this.failPasswordReset) {
      throw new Error('temporary password notice outage')
    }
    if (operation === 'password_change' && this.failPasswordChanged) {
      throw new Error('temporary password notice outage')
    }
    const noticeKinds: Record<string, string> = {
      password_reset: 'passwordReset',
      password_change: 'passwordChanged',
    }
    const kind = noticeKinds[operation]
    if (!kind) throw new Error('unsupported credential notice operation')
    if (this.deliveredOperationIds.has(operationId)) return
    this.deliveredOperationIds.add(operationId)
    this.events.push({
      kind,
      recipient,
      value: operationId,
    })
  },
  async recordLifecycle(event: LifecycleEvent) {
    if (this.failLifecycle) throw new Error('temporary lifecycle observer outage')
    this.lifecycleEvents.push(event)
  },
  reset() {
    this.events.length = 0
    this.lifecycleEvents.length = 0
    this.failRecovery = false
    this.failPasswordReset = false
    this.failPasswordChanged = false
    this.failLifecycle = false
    this.crashAfterOutboxSend = false
    this.deliveredOperationIds.clear()
  },
}
