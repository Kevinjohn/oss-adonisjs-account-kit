import { fileURLToPath } from 'node:url'

export { configure } from './configure.ts'
/** The package's stub directory, for `node ace configure`. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
export * from './src/types.ts'
export * from './src/errors.ts'
export type { sensitivePurposes, socialIntents } from './src/social_enums.ts'
export type { socialProviderNames } from './src/social_providers.ts'
export { AccountKit, defineConfig } from './src/account_kit.ts'

export { createLucidAdapter } from './adapters/lucid.ts'
export { createAllySocialProvider } from './src/ally_social_provider.ts'
export type {
  LucidAdapterOptions,
  LucidCreateAttributes,
  LucidModelLoader,
  LucidModelRow,
  LucidUsersAdapter,
} from './adapters/lucid.ts'
export { accountErrorResponse } from './src/http.ts'
export type { AccountErrorResponse } from './src/http.ts'
export type { PruneInput, PruneCounts } from './src/maintenance.ts'
export { createLogNotifications } from './src/log_notifications.ts'
export type { LogNotificationOptions, MessageLogger } from './src/log_notifications.ts'
export {
  PasswordResetProvision,
  AccountActivationProvision,
  InvitationProvision,
  EmailChangeProvision,
  MagicLinkProvision,
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
