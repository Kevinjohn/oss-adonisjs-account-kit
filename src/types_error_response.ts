/**
 * A safe HTTP response for an Account Kit error: the status, the headers, the content type and
 * the same `{ errors: [...] }` envelope the managed routes send.
 */
export interface AccountErrorResponse {
  /** The HTTP status. */
  status: number
  /**
   * Headers to set: `Vary: Accept`, `Cache-Control` and, when throttled, `Retry-After`. Append
   * `Vary` to the response's existing value rather than replacing it.
   */
  headers: Record<string, string>
  /** `application/vnd.api+json` when the `Accept` header asks for JSON:API, otherwise JSON. */
  contentType: 'application/json' | 'application/vnd.api+json'
  /**
   * The error entries. A plain JSON entry carries `message`, plus `field` when the error names
   * one; a JSON:API entry carries `title` instead. `committed` marks a `E_ACCOUNT_KIT_POST_COMMIT`: the
   * change was saved and a later step failed. A `E_ACCOUNT_KIT_DELIVERY` also follows a saved change but
   * carries no marker.
   */
  body: {
    errors: Array<
      | { code: string; message: string; committed?: true; field?: string }
      | { code: string; title: string; committed?: true }
    >
  }
}

/** The proof an invalid token was for; picks the per-kind invalid-token code. */
export type ProofKind = 'password' | 'email' | 'invitation' | 'magicLink'
