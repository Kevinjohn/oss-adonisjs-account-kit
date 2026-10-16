import { fileURLToPath } from 'node:url'

export { configure } from './configure.ts'
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
export * from './src/types.ts'
export * from './src/errors.ts'
export { AccountKit, defineConfig } from './src/account_kit.ts'

export { createLucidAdapter } from './adapters/lucid.ts'
export { createAllySocialProvider } from './src/ally_social_provider.ts'
export type { LucidAdapterOptions, LucidModelLoader } from './adapters/lucid.ts'
export { accountErrorResponse } from './src/http.ts'
export type { AccountErrorResponse } from './src/http.ts'
export type { PruneInput, PruneCounts } from './src/maintenance.ts'
export {
  PasswordResetProvision,
  AccountActivationProvision,
  InvitationProvision,
  EmailChangeProvision,
  createActionUrls,
  createMailNotifications,
  notificationReadiness,
  renderAccountMessage,
} from './src/notifications.ts'
export type {
  AccountMailMessage,
  AccountMailService,
  ActionUrlOptions,
  MailNotificationOptions,
  NotificationReadinessInput,
  RenderedAccountMessage,
} from './src/notifications.ts'
