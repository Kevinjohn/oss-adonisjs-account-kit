// The admission command loader; `account-kit:admission:install` registers it in `adonisrc.ts`.
import { ListLoader } from '@adonisjs/core/ace'
import ApproveAdmission from './approve.js'
import RevokeAdmission from './revoke.js'
import GrantInvitationEvidence from './grant_invitation.js'
import BootstrapAdmission from './bootstrap.js'

const loader = new ListLoader([
  ApproveAdmission,
  RevokeAdmission,
  GrantInvitationEvidence,
  BootstrapAdmission,
])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
