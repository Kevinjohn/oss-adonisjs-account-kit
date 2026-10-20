/**
 * The part of an `@adonisjs/i18n` `I18n` instance Account Kit uses. Error wording is looked
 * up as `errors.<code>`, with the English message as the fallback.
 */
export interface AccountKitTranslator {
  t(identifier: string, data: Record<string, unknown>, fallbackMessage: string): string
  locale?: string
}
