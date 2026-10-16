import vine from '@vinejs/vine'
import { password } from '#validators/password'

/**
 * Shared rules for email and password.
 */
const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
const fullName = () => vine.string().trim().minLength(1).maxLength(100)

/** The social continuation collects the same trusted name as self-signup. */
export const socialRegistrationValidator = vine.create({ fullName: fullName() })

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
