/**
 * Maintained action-link values; pass their rendered content through createMailNotifications.
 *
 * @example
 * ```ts
 * import { PasswordResetProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new PasswordResetProvision(
 *   'sam@example.test',
 *   'https://app.example.test/reset-password/example-token'
 * )
 * ```
 */
export class PasswordResetProvision {
  readonly kind = 'passwordResetProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
