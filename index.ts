import { fileURLToPath } from 'node:url'

export { configure } from './configure.js'
/** The package's stub directory, for `node ace configure`. */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
export * from './src/types.js'
export * from './src/errors.js'
export type { sensitivePurposes, socialIntents } from './src/social_enums.js'
export type { socialProviderNames } from './src/social_providers.js'
export { AccountKit, defineConfig } from './src/account_kit.js'

export { createLucidAdapter } from './adapters/lucid.js'
export { createAllySocialProvider } from './src/ally_social_provider.js'
export type {
  LucidAdapterOptions,
  LucidCreateAttributes,
  LucidModelLoader,
  LucidModelRow,
  LucidUsersAdapter,
} from './adapters/lucid.js'
export { accountErrorResponse } from './src/error_response.js'
export type { AccountErrorResponse } from './src/error_response.js'
export type { AccountKitTranslator } from './src/translator.js'
export type { PruneInput, PruneCounts } from './src/maintenance.js'
export { createLogNotifications } from './src/log_notifications.js'
export type { LogNotificationOptions, MessageLogger } from './src/log_notifications.js'
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
} from './src/notifications.js'
export type {
  AccountMailMessage,
  AccountMailService,
  ActionUrlOptions,
  MailNotificationOptions,
  NotificationReadinessInput,
  RenderedAccountMessage,
} from './src/notifications.js'
