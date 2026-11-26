export { configure } from './configure.ts'
export { stubsRoot } from './stubs/main.ts'
export * from './src/types.ts'
export * from './src/errors.ts'
export * as errors from './src/errors.ts'
export type { sensitivePurposes, socialIntents } from './src/social_enums.ts'
export type { socialProviderNames } from './src/social_providers.ts'
export { AccountKit, defineConfig } from './src/account_kit.ts'
export { AccountKitCallbackConfiguration } from './src/account_kit_callback_configuration.ts'

export { createLucidAdapter } from './src/adapters/lucid.ts'
export { createAllySocialProvider } from './src/ally_social_provider.ts'
export type {
  LucidAdapterOptions,
  LucidCreateAttributes,
  LucidModelLoader,
  LucidModelRow,
  LucidUsersAdapter,
} from './src/adapters/lucid.ts'
export { accountErrorResponse } from './src/error_response.ts'
export { passwordChangeRevision } from './src/password_change_revision.ts'
export type { AccountErrorResponse } from './src/error_response.ts'
export type { ProofKind } from './src/error_identity.ts'
export type { AccountKitTranslator } from './src/translator.ts'
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
