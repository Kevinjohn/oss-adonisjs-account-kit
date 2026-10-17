// Timing-floor wait shared by flows that must not reveal which branch they took.
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Waits until `floorMs` has elapsed since `started` (a `performance.now()` reading).
 * Timers can wake early, so keep waiting until the floor has actually passed.
 */
export async function waitForFloor(started: number, floorMs: number): Promise<void> {
  let remaining = floorMs - (performance.now() - started)
  while (remaining > 0) {
    await delay(Math.ceil(remaining))
    remaining = floorMs - (performance.now() - started)
  }
}
