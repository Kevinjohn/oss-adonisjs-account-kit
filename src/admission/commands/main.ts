// The admission command loader; `account-kit:admission:install` registers it in `adonisrc.ts`.
import { ListLoader } from '@adonisjs/core/ace'
import ApproveAdmission from '../../../commands/admission/approve.ts'
import RevokeAdmission from '../../../commands/admission/revoke.ts'
import GrantInvitationEvidence from '../../../commands/admission/grant_invitation.ts'
import BootstrapAdmission from '../../../commands/admission/bootstrap.ts'

const loader = new ListLoader([
  ApproveAdmission,
  RevokeAdmission,
  GrantInvitationEvidence,
  BootstrapAdmission,
])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
