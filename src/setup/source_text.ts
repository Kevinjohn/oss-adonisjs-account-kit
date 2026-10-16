/** Remove JavaScript/TypeScript comments without changing quoted source text or offsets. */
export function stripSourceComments(source: string): string {
  let result = ''
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code'
  const interpolations: number[] = []

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]

    if (mode === 'line') {
      if (char === '\n' || char === '\r') {
        result += char
        mode = 'code'
      } else result += ' '
      continue
    }
    if (mode === 'block') {
      if (char === '*' && next === '/') {
        result += '  '
        index++
        mode = 'code'
      } else result += char === '\n' || char === '\r' ? char : ' '
      continue
    }

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      result += char
      if (char === '\\' && next !== undefined) {
        result += next
        index++
      } else if ((mode === 'single' && char === "'") || (mode === 'double' && char === '"')) {
        mode = 'code'
      } else if (mode === 'template') {
        if (char === '`') mode = 'code'
        else if (char === '$' && next === '{') {
          result += next
          index++
          interpolations.push(1)
          mode = 'code'
        }
      }
      continue
    }

    if (char === '/' && (next === '/' || next === '*')) {
      result += '  '
      index++
      mode = next === '/' ? 'line' : 'block'
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      result += char
      mode = char === "'" ? 'single' : char === '"' ? 'double' : 'template'
      continue
    }
    if (interpolations.length) {
      const top = interpolations.length - 1
      if (char === '{') interpolations[top]++
      else if (char === '}' && --interpolations[top] === 0) {
        interpolations.pop()
        mode = 'template'
      }
    }
    result += char
  }

  return result
}
