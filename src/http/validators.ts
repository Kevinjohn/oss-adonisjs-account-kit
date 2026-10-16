import vine from '@vinejs/vine'

const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(256)
const registrationData = () => vine.record(vine.any()).optional()

export const loginValidator = vine.compile(vine.object({ email: email(), password: vine.string() }))
export const signupValidator = vine.compile(
  vine.object({
    email: email(),
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
    registrationData: registrationData(),
  })
)
export const passwordResetRequestValidator = vine.compile(vine.object({ email: email() }))
export const passwordResetCompleteValidator = vine.compile(
  vine.object({
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
  })
)
export const passwordChangeValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1).optional(),
    recentProof: vine.string().minLength(1).optional(),
    newPassword: password(),
    newPasswordConfirmation: vine.string().sameAs('newPassword'),
  })
)
export const profileUpdateValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1).optional(),
    recentProof: vine.string().minLength(1).optional(),
    email: email().optional(),
    registrationData: registrationData(),
  })
)
export const invitationSendValidator = vine.compile(
  vine.object({
    email: email(),
    role: vine.string().trim().minLength(1).maxLength(64),
  })
)
export const invitationAcceptValidator = vine.compile(
  vine.object({
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
    registrationData: registrationData(),
  })
)
export const invitationListValidator = vine.compile(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    cursor: vine.string().optional(),
  })
)

export const socialBeginValidator = vine.compile(
  vine.object({
    intent: vine.string().optional(),
    purpose: vine.string().optional(),
    proof: vine.string().optional(),
    clientChallenge: vine.string().optional(),
  })
)
export const socialConfirmationValidator = vine.compile(
  vine.object({
    verificationToken: vine.string().minLength(1),
    clientChallenge: vine.string().optional(),
  })
)
export const socialCallbackValidator = vine.compile(
  vine.object({
    state: vine.string().minLength(1),
    code: vine.string().optional(),
    intent: vine.string().optional(),
  })
)
export const socialRegistrationValidator = vine.compile(
  vine.object({
    continuation: vine.string().minLength(1),
    email: email().optional(),
    registrationData: vine.any().optional(),
  })
)
export const socialTokenValidator = vine.compile(
  vine.object({ code: vine.string().minLength(1), verifier: vine.string().minLength(43) })
)
export const socialPasswordProofValidator = vine.compile(
  vine.object({ password: vine.string().minLength(1), purpose: vine.string().minLength(1) })
)
export const socialUnlinkValidator = vine.compile(
  vine.object({ proof: vine.string().minLength(1) })
)
