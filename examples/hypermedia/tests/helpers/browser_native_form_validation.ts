/* eslint-disable @unicorn/no-await-expression-member -- Browser actions are asserted beside their results. */

/** Session.commit flattens input fields beside the framework validation bags. */
export function oldInputFromFlash(flash: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(flash).filter(([key]) => !['errorsBag', 'inputErrorsBag'].includes(key))
  )
}

export const origin = process.env.APP_URL!
