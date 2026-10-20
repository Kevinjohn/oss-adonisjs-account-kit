// The admission command loader; `account-kit:admission:install` registers it in `adonisrc.ts`.
import { ListLoader } from '@adonisjs/core/ace'
import ApproveAdmission from './approve.js'
import RevokeAdmission from './revoke.js'
import GrantInvitationEvidence from './grant_invitation.js'

const loader = new ListLoader([ApproveAdmission, RevokeAdmission, GrantInvitationEvidence])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
