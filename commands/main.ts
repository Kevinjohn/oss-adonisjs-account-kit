// Source specs use this loader. The build generates its own with adonis-kit.
import { ListLoader } from '@adonisjs/core/ace'
import PruneAccountKit from './prune.ts'
import SetupAccountKit from './setup.ts'
import RetirementImpact from './retirement_impact.ts'
import AccountKitDoctor from './doctor.ts'
import InviteAccount from './invite.ts'
import ResetLink from './reset_link.ts'
import ManagedOpenApi from './openapi.ts'
import InstallAdmission from './admission_install.ts'

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
