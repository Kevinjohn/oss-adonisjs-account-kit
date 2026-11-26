/**
 * An invitation email to send: recipient and action URL.
 *
 * @example
 * ```ts
 * import { InvitationProvision } from '@kevinjohn/adonisjs-account-kit'
 *
 * const provision = new InvitationProvision(
 *   'sam@example.test',
 *   'https://app.example.test/accept-invitation/example-token'
 * )
 * ```
 */
export class InvitationProvision {
  readonly kind = 'invitationProvision' as const
  constructor(
    readonly recipient: string,
    readonly actionUrl: string
  ) {}
}
