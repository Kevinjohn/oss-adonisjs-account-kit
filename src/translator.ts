/**
 * The part of an `@adonisjs/i18n` `I18n` instance Account Kit uses. Error wording is looked
 * up as `errors.<code>`, with the English message as the fallback.
 */
export interface AccountKitTranslator {
  /** Translate `identifier` with `data`, returning `fallbackMessage` when no translation exists. */
  t(identifier: string, data: Record<string, unknown>, fallbackMessage: string): string
  locale?: string
}
