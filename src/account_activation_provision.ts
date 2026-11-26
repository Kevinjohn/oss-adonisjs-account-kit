/**
 * An account activation email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { AccountActivationProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new AccountActivationProvision(
 *   'sam@example.test',
 *   'https://app.example.test/activate/example-token'
 * )
 * ```
 */
export class AccountActivationProvision {
  readonly kind = 'accountActivationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
