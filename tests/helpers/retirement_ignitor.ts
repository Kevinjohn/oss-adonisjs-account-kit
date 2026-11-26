import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { pathToFileURL } from 'node:url'
import SetupAccountKit from '../../commands/setup.ts'
import RetirementImpact from '../../commands/retirement_impact.ts'
import { AccountKit } from '../../src/account_kit.ts'

export function retirementIgnitor(
  root: string,
  impact: (input?: {
    passwordLogin: boolean
    providers?: readonly string[]
    onlyWhenRetiring?: boolean
  }) => Promise<{
    inspectedAccounts: number
    affectedAccounts: number
    checkedAt: string
    currentProviders?: Array<'google' | 'github'>
    currentPasswordLogin?: boolean
  }>,
  setupCommand: typeof SetupAccountKit = SetupAccountKit
) {
  const provider = async () => ({
    default: class {
      #app: { container: { bindValue: (key: typeof AccountKit, value: AccountKit) => void } }

      constructor(app: {
        container: { bindValue: (key: typeof AccountKit, value: AccountKit) => void }
      }) {
        this.#app = app
      }
      register() {
        this.#app.container.bindValue(AccountKit, {
          authentication: { retirementImpact: impact },
        } as unknown as AccountKit)
      }
    },
  })
  return new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      rcFileContents: {
        providers: [provider],
        commands: [async () => new ListLoader([setupCommand, RetirementImpact])],
      },
    })
    .create(pathToFileURL(`${root}/`))
}
