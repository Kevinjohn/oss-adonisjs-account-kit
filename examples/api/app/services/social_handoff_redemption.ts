import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import User from '#models/user'
import type { accountKitSessionGuard } from '#services/account_kit_guards'

/**
 * Redeems a social callback's handoff code with the browser's verifier through the session guard,
 * and returns the signed-in user and the provider used.
 */
export async function redeemSocialHandoff(input: {
  code: string
  verifier: string
  guard: ReturnType<typeof accountKitSessionGuard>
}) {
  const redeemed = await accountKit.socialAuthentication.redeemHandoff(input)
  return { user: await User.findOrFail(redeemed.account.id), provider: redeemed.provider }
}
