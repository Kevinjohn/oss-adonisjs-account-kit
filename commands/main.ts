import { ListLoader } from '@adonisjs/core/ace'
import PruneAccountKit from './prune.js'
import SetupAccountKit from './setup.js'
import RetirementImpact from './retirement_impact.js'
import AccountKitDoctor from './doctor.js'
import InviteAccount from './invite.js'
import ResetLink from './reset_link.js'
import ManagedOpenApi from './openapi.js'
import InstallAdmission from './admission_install.js'

const loader = new ListLoader([
  PruneAccountKit,
  SetupAccountKit,
  RetirementImpact,
  AccountKitDoctor,
  InviteAccount,
  ResetLink,
  ManagedOpenApi,
  InstallAdmission,
])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
