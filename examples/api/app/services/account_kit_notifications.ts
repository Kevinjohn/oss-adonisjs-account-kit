import type { LifecycleEvent } from 'adonisjs-account-kit'

export type Notice = { kind: string; recipient: string; value: string }

const failureSwitches = {
  failRecovery: false,
  failVerification: false,
  failPasswordReset: false,
  failPasswordChanged: false,
  failLifecycle: false,
  crashAfterOutboxSend: false,
}
type FailureSwitch = keyof typeof failureSwitches

/** The switch that makes each notice kind fail, and the outage message it throws. */
const deliveryFailures: Record<string, [FailureSwitch, string]> = {
  recovery: ['failRecovery', 'temporary delivery outage'],
  verification: ['failVerification', 'temporary verification delivery outage'],
  passwordReset: ['failPasswordReset', 'temporary password notice outage'],
  passwordChanged: ['failPasswordChanged', 'temporary password notice outage'],
}

const noticeKinds: Record<string, string> = {
  password_reset: 'passwordReset',
  password_change: 'passwordChanged',
}

export const notifications = {
  events: [] as Notice[],
  lifecycleEvents: [] as LifecycleEvent[],
  ...failureSwitches,
  deliveredOperationIds: new Set<string>(),
  failIfSwitchedOn(kind: string) {
    const failure = deliveryFailures[kind]
    if (failure && this[failure[0]]) throw new Error(failure[1])
  },
  async send(kind: string, recipient: string, value: string) {
    this.failIfSwitchedOn(kind)
    this.events.push({ kind, recipient, value })
  },
  async deliverCredentialNotice(operationId: string, operation: string, recipient: string) {
    const kind = noticeKinds[operation]
    if (!kind) throw new Error('unsupported credential notice operation')
    this.failIfSwitchedOn(kind)
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
    Object.assign(this, failureSwitches)
    this.deliveredOperationIds.clear()
  },
}
