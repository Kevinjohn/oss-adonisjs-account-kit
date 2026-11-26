export const stateFrom = (url: string) => new URL(url).searchParams.get('state')!

export type Body = Record<string, unknown>
export const body = (response: { body(): unknown }) => response.body() as Body

export const continuationFrom = (response: { body(): unknown }): string => {
  const continuation = body(response).continuation
  if (typeof continuation !== 'string') throw new Error('Expected social continuation')
  return continuation
}
