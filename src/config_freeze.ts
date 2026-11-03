// Freezes configuration the resolver built. The type stays mutable so the public resolved types
// do not change; a runtime write to a frozen value throws in strict mode.
export function freezeResolved<T extends object>(value: T): T {
  return Object.freeze(value) as T
}
