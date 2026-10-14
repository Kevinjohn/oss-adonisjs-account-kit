import { ListLoader } from '@adonisjs/core/ace'
import PruneAccountKit from './prune.js'

const loader = new ListLoader([PruneAccountKit])
export const getMetaData = loader.getMetaData.bind(loader)
export const getCommand = loader.getCommand.bind(loader)
