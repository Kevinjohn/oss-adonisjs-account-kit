import SetupAccountKit from '../../commands/setup.js'

/** Run the setup prompts, answering each question that starts with a key and leaving the rest blank. */
export async function interactive(answers: Record<string, string> = {}) {
  return SetupAccountKit.prototype.interactiveChoices.call(
    { logger: { info() {} } } as unknown as SetupAccountKit,
    async (question) =>
      Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1] ?? ''
  )
}
