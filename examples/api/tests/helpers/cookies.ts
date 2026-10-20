/** Join a response's `set-cookie` values into one `cookie` request header. */
export function cookies(response: { header(name: string): string | string[] | undefined }): string {
  const values = response.header('set-cookie')
  return (Array.isArray(values) ? values : [values])
    .filter(Boolean)
    .map((value) => String(value).split(';', 1)[0])
    .join('; ')
}
