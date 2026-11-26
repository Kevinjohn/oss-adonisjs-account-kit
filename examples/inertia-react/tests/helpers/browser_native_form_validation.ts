/** Session.commit flattens its input bag into top-level flash entries. */
export function oldInputFromFlash(flash: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(flash).filter(([key]) => !['errorsBag', 'inputErrorsBag'].includes(key))
  )
}
