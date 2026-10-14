const MAX_RAW_EMAIL_LENGTH = 512

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isEmailShaped(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_RAW_EMAIL_LENGTH) return false

  const email = normaliseEmail(value)
  if (email.length < 3 || email.length > 254 || /\s/.test(email)) return false

  const at = email.indexOf('@')
  return at > 0 && at < email.length - 1 && at === email.lastIndexOf('@')
}
