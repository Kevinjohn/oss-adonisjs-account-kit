export function bearerFromLogin(response: { body(): unknown }): string {
  const body = response.body()
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new Error('Login response is missing its data envelope')
  }
  const data = body.data
  if (typeof data !== 'object' || data === null || !('token' in data)) {
    throw new Error('Token login response is missing its token')
  }
  const token = data.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Token login response contains an invalid token')
  }
  return token
}
