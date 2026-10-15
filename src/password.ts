export function isPasswordShaped(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 256
}
