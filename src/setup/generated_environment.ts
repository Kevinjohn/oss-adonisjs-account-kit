import type { SetupChoices } from './types.js'
import { hasEmailFlow } from './shared.js'

export function generatedEnv(choices: SetupChoices): string {
  const names = new Set<string>()
  if (hasEmailFlow(choices)) {
    names.add(choices.mail.backendOriginEnv)
    names.add(choices.mail.frontendOriginEnv)
    if (choices.mail.senderEnv) names.add(choices.mail.senderEnv)
    if (choices.mail.transportEnv) names.add(choices.mail.transportEnv)
  }
  if (choices.social.status === 'enabled') {
    names.add(choices.social.callbackOriginEnv)
    for (const provider of choices.social.providers) {
      const refs = choices.social.credentials[provider]
      if (refs) {
        names.add(refs.clientIdEnv)
        names.add(refs.clientSecretEnv)
      }
    }
  }
  return [
    '# Account Kit deployment values; supply real values through your deployment environment',
    ...[...names].sort().map((name) => `${name}=`),
    '',
  ].join('\n')
}
