/** Thrown when applying setup fails after some files were already published. */
export class SetupApplyInterruptedError extends Error {
  readonly written: string[]

  constructor(written: string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(
      `Setup failed after writing ${written.length} file(s): ${reason}. Already written: ${written.join(', ')}. Fix the cause and rerun setup; it continues from there.`,
      { cause }
    )
    this.name = 'SetupApplyInterruptedError'
    this.written = written
  }
}
