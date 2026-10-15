import vine from '@vinejs/vine'

const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(256)

export const loginValidator = vine.compile(vine.object({ email: email(), password: vine.string() }))
export const signupValidator = vine.compile(
  vine.object({
    email: email(),
    password: password(),
    passwordConfirmation: vine.string().sameAs('password'),
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
    currentPassword: vine.string().minLength(1),
    newPassword: password(),
    newPasswordConfirmation: vine.string().sameAs('newPassword'),
  })
)
export const profileUpdateValidator = vine.compile(
  vine.object({
    currentPassword: vine.string().minLength(1),
    email: email().optional(),
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
  })
)
export const invitationListValidator = vine.compile(
  vine.object({
    limit: vine.number().withoutDecimals().min(1).max(100).optional(),
    cursor: vine.string().optional(),
  })
)
