export { configure } from './configure.js'
export { stubsRoot } from './stubs/main.js'
export * from './src/types.js'
export * from './src/errors.js'
export * as errors from './src/errors.js'
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
export { passwordChangeRevision } from './src/password_change_revision.js'
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
