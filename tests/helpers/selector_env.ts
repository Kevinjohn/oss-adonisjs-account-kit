/** Selector variables setup reads; a value set on the host would override a fixture's `.env`. */
const selectorNames = ['DB_CONNECTION', 'MAIL_MAILER', 'LIMITER_STORE', 'SESSION_DRIVER']

/** Removes the host's selector variables and returns a function that puts them back. */
export function clearSelectorEnv(): () => void {
  const prior = Object.fromEntries(selectorNames.map((name) => [name, process.env[name]]))
  for (const name of selectorNames) delete process.env[name]
  return () => {
    for (const [name, value] of Object.entries(prior))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  }
}
