/** Read the token from the last path segment of a notification link. */
export const tokenFrom = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').at(-1)!)
