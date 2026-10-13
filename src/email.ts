export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isEmailShaped(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 254) return false
  const at = value.indexOf('@')
  return at !== -1 && at === value.lastIndexOf('@')
}
