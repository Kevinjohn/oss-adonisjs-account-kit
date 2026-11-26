import type {
  ManagedQueries,
  ManagedRequestBodies,
  ManagedSuccessBodies,
} from './contract_types.ts'
import type { ManagedEndpointName } from './route_types.ts'

export type * from './contract_types.ts'

type CompleteInventory =
  Exclude<ManagedEndpointName, keyof ManagedSuccessBodies> extends never
    ? Exclude<keyof ManagedSuccessBodies, ManagedEndpointName> extends never
      ? Exclude<ManagedEndpointName, keyof ManagedRequestBodies> extends never
        ? Exclude<keyof ManagedRequestBodies, ManagedEndpointName> extends never
          ? Exclude<ManagedEndpointName, keyof ManagedQueries> extends never
            ? Exclude<keyof ManagedQueries, ManagedEndpointName> extends never
              ? true
              : never
            : never
          : never
        : never
      : never
    : never

export const managedSuccessContractComplete: CompleteInventory = true
