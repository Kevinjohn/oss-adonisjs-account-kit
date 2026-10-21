import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'

/** Captures proof URLs only inside the isolated test process. */
export const accountKitNotifications = captureNotifications()

/** Keeps test failure injection live after AdonisJS resolves its account configuration. */
export const accountKitNotify = new Proxy(accountKitNotifications.notify, {
  get(target, property, receiver) {
    const callback = Reflect.get(target, property, receiver)
    if (typeof callback !== 'function') return callback
    return (...args: unknown[]) => Reflect.get(target, property, receiver)(...args)
  },
})
