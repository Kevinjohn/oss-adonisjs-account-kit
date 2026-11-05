const SAFE_OLD_INPUT_FIELDS = ['fullName', 'email'] as const

export function safeOldInput(body: Record<string, unknown>) {
  const oldInput: Record<string, string> = {}

  for (const field of SAFE_OLD_INPUT_FIELDS) {
    const value = body[field]
    if (Object.hasOwn(body, field) && value === null) oldInput[field] = ''
    else if (typeof value === 'string' && value.length <= 320) oldInput[field] = value
  }

  return oldInput
}
