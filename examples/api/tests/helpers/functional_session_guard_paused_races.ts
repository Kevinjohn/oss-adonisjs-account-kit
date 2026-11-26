import User from '#models/user'

export function pauseNextSessionLookup(userId: number | string) {
  const original = User.findOrFail
  const lookup = original.bind(User)
  let signalPaused!: () => void
  let signalResume!: () => void
  const paused = new Promise<void>((resolve) => (signalPaused = resolve))
  const resume = new Promise<void>((resolve) => (signalResume = resolve))
  let waiting = true
  Reflect.set(User, 'findOrFail', async (id: number | string) => {
    const found = await lookup(id)
    if (waiting && String(id) === String(userId)) {
      waiting = false
      signalPaused()
      await resume
    }
    return found
  })
  return {
    paused,
    release() {
      Reflect.set(User, 'findOrFail', original)
      signalResume()
    },
  }
}
