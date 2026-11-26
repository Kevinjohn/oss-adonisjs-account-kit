// Shared guard for config sections that must be non-null, non-array objects.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'

/**
 * Throws `account_kit: <name> must be an object` unless the value is a non-null, non-array object.
 */
export function assertObject(value: unknown, name: string): asserts value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(name, `account_kit: ${name} must be an object`)
}
