import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'

/** Captures proof URLs only inside the isolated test process. */
export const accountKitNotifications = captureNotifications()
