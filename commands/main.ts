import { ListLoader } from '@adonisjs/core/ace'
import PruneAccountKit from './prune.js'
import SetupAccountKit from './setup.js'
import RetirementImpact from './retirement_impact.js'
import InviteAccount from './invite.js'
import ResetLink from './reset_link.js'

const loader = new ListLoader([
  PruneAccountKit,
  SetupAccountKit,
  RetirementImpact,
  InviteAccount,
  ResetLink,
])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
