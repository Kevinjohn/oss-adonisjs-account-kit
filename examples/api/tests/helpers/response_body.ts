/** Read a test response body as the shape the test expects. */
export const responseBody = <T>(response: { body(): unknown }) => response.body() as T
