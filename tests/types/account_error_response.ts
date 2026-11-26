import { accountErrorResponse, type AccountErrorResponse } from '../../index.ts'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false

/** The public root export keeps the default and negotiated response types distinct. */
export function assertAccountErrorResponseTypes(error: unknown, accept: string | undefined): void {
  const defaultResponse = accountErrorResponse(error)
  const defaultMayBeNull: null extends typeof defaultResponse ? true : false = true
  if (defaultResponse) {
    const contentType: 'application/json' = defaultResponse.contentType
    const [entry] = defaultResponse.body.errors
    if (entry) {
      const message: string = entry.message
      // @ts-expect-error Default JSON entries do not have a JSON:API title.
      const title: string = entry.title
      void [message, title]
    }
    void contentType
  }

  const explicitUndefinedResponse = accountErrorResponse(error, undefined)
  if (explicitUndefinedResponse) {
    const contentType: 'application/json' = explicitUndefinedResponse.contentType
    const [entry] = explicitUndefinedResponse.body.errors
    if (entry) {
      const message: string = entry.message
      void message
    }
    void contentType
  }

  const negotiatedResponse = accountErrorResponse(error, { accept })
  const negotiatedMayBeNull: null extends typeof negotiatedResponse ? true : false = true
  if (negotiatedResponse) {
    const contentType: AccountErrorResponse['contentType'] = negotiatedResponse.contentType
    const [entry] = negotiatedResponse.body.errors
    if (entry) {
      // @ts-expect-error An options object retains the negotiated JSON/JSON:API entry union.
      const message: string = entry.message
      // @ts-expect-error An options object retains the negotiated JSON/JSON:API entry union.
      const title: string = entry.title
      if ('message' in entry) {
        const narrowedMessage: string = entry.message
        void narrowedMessage
      }
      if ('title' in entry) {
        const narrowedTitle: string = entry.title
        void narrowedTitle
      }
      void [message, title]
    }
    void contentType
  }

  const returnTypeIsBroad: Equal<
    ReturnType<typeof accountErrorResponse>,
    AccountErrorResponse | null
  > = true
  void [defaultMayBeNull, negotiatedMayBeNull, returnTypeIsBroad]
}
