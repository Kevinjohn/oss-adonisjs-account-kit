/** A trimmed `fullName` from registration data, or null when it is missing or blank. */
export function registrationFullName(data: unknown): string | null {
  if (data === undefined || data === null) return null
  if (typeof data !== 'object' || Array.isArray(data))
    throw new Error('Registration data must be an object')
  const fullName = (data as { fullName?: unknown }).fullName
  if (fullName === undefined || fullName === null) return null
  if (typeof fullName !== 'string') throw new Error('A full name must be a string')
  if (fullName.trim() === '') return null
  return fullName.trim()
}
