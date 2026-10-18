import { ListLoader } from '@adonisjs/core/ace'
import { IgnitorFactory } from '@adonisjs/core/factories'
import { pathToFileURL } from 'node:url'
import SetupAccountKit from '../../commands/setup.js'
import RetirementImpact from '../../commands/retirement_impact.js'
import { AccountKit } from '../../src/account_kit.js'

export function retirementIgnitor(
  root: string,
  impact: (input?: { passwordLogin: boolean; providers?: readonly string[] }) => Promise<{
    inspectedAccounts: number
    affectedAccounts: number
    checkedAt: string
    currentProviders?: Array<'google' | 'github'>
    currentPasswordLogin?: boolean
  }>
) {
  const provider = async () => ({
    default: class {
      constructor(
        private app: {
          container: { bindValue: (key: typeof AccountKit, value: AccountKit) => void }
        }
      ) {}
      register() {
        this.app.container.bindValue(AccountKit, {
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
        commands: [async () => new ListLoader([SetupAccountKit, RetirementImpact])],
      },
    })
    .create(pathToFileURL(`${root}/`))
}
