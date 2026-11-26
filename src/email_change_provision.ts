/**
 * An email-change confirmation to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { EmailChangeProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new EmailChangeProvision(
 *   'sam@example.test',
 *   'https://app.example.test/confirm-email/example-token'
 * )
 * ```
 */
export class EmailChangeProvision {
  readonly kind = 'emailChangeProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
