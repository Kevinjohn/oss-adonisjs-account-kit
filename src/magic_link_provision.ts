/**
 * A magic sign-in link email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { MagicLinkProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new MagicLinkProvision(
 *   'sam@example.test',
 *   'https://app.example.test/sign-in/example-token'
 * )
 * ```
 */
export class MagicLinkProvision {
  readonly kind = 'magicLinkProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
