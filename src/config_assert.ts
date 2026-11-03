// Shared guard for config sections that must be plain objects.
import { InvalidConfigurationError } from './errors.js'

/**
 * Throws `account_kit: <name> must be an object` unless the value is a non-null, non-array object.
 */
export function assertPlainObject(value: unknown, name: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidConfigurationError(name, `account_kit: ${name} must be an object`)
}
