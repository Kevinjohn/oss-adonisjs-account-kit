export const stateFrom = (url: string) => new URL(url).searchParams.get('state')!

export type Body = Record<string, unknown>
export const body = (response: { body(): unknown }) => response.body() as Body
