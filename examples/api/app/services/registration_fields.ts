/** The trimmed `fullName` from registration data, or undefined when it is missing or blank. */
export function registrationFullName(data: unknown): string | undefined {
  const fullName = (data as { fullName?: unknown } | null)?.fullName
  if (typeof fullName !== 'string' || fullName.trim() === '') return undefined
  return fullName.trim()
}
