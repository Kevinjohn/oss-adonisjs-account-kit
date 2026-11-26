// The admission command loader; `account-kit:admission:install` registers it in `adonisrc.ts`.
import { ListLoader } from '@adonisjs/core/ace'
import ApproveAdmission from './approve.ts'
import RevokeAdmission from './revoke.ts'
import GrantInvitationEvidence from './grant_invitation.ts'
import BootstrapAdmission from './bootstrap.ts'

const loader = new ListLoader([
  ApproveAdmission,
  RevokeAdmission,
  GrantInvitationEvidence,
  BootstrapAdmission,
])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
