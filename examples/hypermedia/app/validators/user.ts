import vine, { SimpleMessagesProvider } from '@vinejs/vine'

// Only the account forms use this application's English copy.
export const accountMessages = new SimpleMessagesProvider(
  {
    'required': '{{ field }} is required.',
    'email': 'Enter a valid email address.',
    'unique': 'This email address is already in use.',
    'minLength': '{{ field }} must be at least {{ min }} characters.',
    'maxLength': '{{ field }} must be {{ max }} characters or fewer.',
    'email.required': 'Enter your email address.',
    'password.required': 'Enter your password.',
    'currentPassword.required': 'Enter your current password.',
    'passwordConfirmation.required': 'Confirm your password.',
    'passwordConfirmation.sameAs': 'Confirm password must match Password.',
  },
  {
    fullName: 'Full name',
    email: 'Email',
    password: 'Password',
    currentPassword: 'Current password',
    passwordConfirmation: 'Confirm password',
  }
)

/**
 * Shared rules for email and password.
 */
// Account Kit stores addresses trimmed and lowercase, so the unique check must compare them that way.
export const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
export const password = () => vine.string().minLength(8).maxLength(32)

/**
 * Validator to use when performing self-signup.
 *
 * The "passwordConfirmation" field is declared explicitly, so that it is part
 * of the request body type shared with the frontend. Otherwise the signup form
 * has no way to know about the errors reported for this field.
 */
export const signupValidator = vine.create({
  fullName: vine.string().trim().minLength(1).maxLength(255).nullable(),
  email: email().unique({ table: 'users', column: 'email' }),
  password: password(),
  passwordConfirmation: password().sameAs('password'),
})
signupValidator.messagesProvider = accountMessages

/**
 * Validator to use before validating user credentials
 * during login
 */
export const loginValidator = vine.create({
  email: email(),
  password: vine.string(),
})
loginValidator.messagesProvider = accountMessages
