import { AccountAdmission } from '../../src/admission/service.js'
import { defineAdmission } from '../../src/admission/config.js'
import type { AdmissionConfig } from '../../src/admission/types.js'
import type { AccountKitConfig, UserId } from '../../src/types.js'
import type { TestApp } from './app.js'
import { dbTime } from './db_time.js'
import { makeService } from './account_kit_service.js'

export const allowDecisions = {
  decide: async () => true,
  list: async () => true,
}

/** Every requirement on, with approvers allowed by default. */
export const allRequirements: AdmissionConfig = {
  domain: { allowed: ['example.test'] },
  invitation: { required: true },
  approval: { required: true, authorize: allowDecisions },
}

/** An account service and an admission service over the same database. */
export function makeAdmission(
  kit: TestApp,
  admission: AdmissionConfig = allRequirements,
  overrides: Partial<AccountKitConfig> = {}
) {
  const service = makeService(kit, overrides)
  const config = defineAdmission(admission)
  return {
    ...service,
    admissionConfig: config,
    admission: new AccountAdmission({
      kit: service.account,
      db: kit.db,
      accountConfig: service.config,
      config,
    }),
  }
}

/** Write admission columns for a user directly, as a test fixture. */
export async function writeAdmissionRow(
  kit: TestApp,
  userId: UserId,
  values: {
    requested?: boolean
    invited?: boolean
    approval?: 'approved' | 'rejected' | 'revoked'
    actorId?: UserId | null
  }
): Promise<void> {
  const now = dbTime(kit)
  const columns = {
    requested_at: values.requested ? now : null,
    invitation_id: values.invited ? 1 : null,
    invited_email: values.invited ? 'invited@example.test' : null,
    invited_role: values.invited ? 'member' : null,
    invitation_source: values.invited ? 'invitation' : null,
    invitation_recorded_at: values.invited ? now : null,
    approval_status: values.approval ?? null,
    approval_actor_id: values.approval ? (values.actorId ?? null) : null,
    approval_decided_at: values.approval ? now : null,
    updated_at: now,
  }
  const existing = await kit.db.from('account_admissions').where('user_id', userId).first()
  if (existing) await kit.db.from('account_admissions').where('user_id', userId).update(columns)
  else
    await kit.db
      .table('account_admissions')
      .insert({ ...columns, user_id: userId, created_at: now })
}
