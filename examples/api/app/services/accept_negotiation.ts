/** Prefer JSON:API only when the request accepts it with nonzero, leading quality. */
export function wantsJsonApi(accept: string | undefined): boolean {
  if (!accept) return false
  const ranges: Array<{ mediaType: string; quality: number }> = []
  for (const range of accept.split(',')) {
    const [mediaType, ...parameters] = range.split(';').map((part) => part.trim().toLowerCase())
    const qualityParameter = parameters.find((part) => part.startsWith('q='))
    const quality = qualityParameter ? Number(qualityParameter.slice(2)) : 1
    if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue
    ranges.push({ mediaType, quality })
  }
  const qualityFor = (mediaType: string) => {
    for (const candidate of [mediaType, 'application/*', '*/*']) {
      const matches = ranges.filter((range) => range.mediaType === candidate)
      if (matches.length > 0) return Math.max(...matches.map((match) => match.quality))
    }
    return 0
  }
  const jsonApi = qualityFor('application/vnd.api+json')
  const json = qualityFor('application/json')
  return (
    ranges.some((range) => range.mediaType === 'application/vnd.api+json' && range.quality > 0) &&
    jsonApi > 0 &&
    jsonApi >= json
  )
}
