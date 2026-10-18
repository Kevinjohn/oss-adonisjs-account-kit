import vine from '@vinejs/vine'

const password = () => vine.string().minLength(8).maxLength(32)

export const forgotPasswordValidator = vine.create({
  email: vine.string().email().maxLength(254),
})

export const resetPasswordValidator = vine.create({
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

export const verifyEmailValidator = vine.create({
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

export const changePasswordValidator = vine.create({
  currentPassword: vine.string(),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})
