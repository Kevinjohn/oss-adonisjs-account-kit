import type { AccountKit } from '../../index.ts'

type Dependencies = ConstructorParameters<typeof AccountKit>[0]

/** The constructor no longer accepts the ignored `encryption` input. */
export function withEncryption(dependencies: Dependencies): Dependencies {
  // @ts-expect-error `encryption` is not a constructor input.
  return { ...dependencies, encryption: undefined }
}
