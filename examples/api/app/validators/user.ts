import vine from '@vinejs/vine'
import { email, fullName } from '#validators/fields'
import { password } from '#validators/password'

/** The social continuation collects the same trusted name as self-signup. */
export const socialRegistrationValidator = vine.create({
  continuation: vine.string().minLength(1),
  fullName: fullName(),
  email: email().optional(),
})

/**
 * Validator to use when performing self-signup
 */
export const signupValidator = vine.create({
  fullName: fullName(),
  email: email(),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})

/**
 * Validator to use before validating user credentials
 * during login
 */
export const loginValidator = vine.create({
  email: email(),
  password: vine.string(),
})
