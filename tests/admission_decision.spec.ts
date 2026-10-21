import { test } from '@japa/runner'
import type { AdmissionConfig } from '../src/admission/types.js'
import { useAdmissionApp } from './helpers/admission_schema.js'
import { allowDecisions, makeAdmission, writeAdmissionRow } from './helpers/admission.js'
import { credentialsFixtures } from './helpers/credentials.js'
import { insertUser, makeNotify } from './helpers/fakes.js'

type Requirement = 'domain' | 'invitation' | 'approval'
const requirementConfig: Record<Requirement, AdmissionConfig> = {
  domain: { domain: { allowed: ['example.test'] } },
  invitation: { invitation: { required: true } },
  approval: { approval: { required: true, authorize: allowDecisions } },
}

test.group('admission decision against stored accounts', (group) => {
  const kit = useAdmissionApp(group)
  const { issueEmailChange } = credentialsFixtures(kit)

  test('a pending email change does not count until it is confirmed', async ({ assert }) => {
    const recorder = makeNotify()
    const { admission, account } = makeAdmission(kit, requirementConfig.domain, {
      minRequestMs: 0,
      notify: recorder.notify,
    })
    const inside = await insertUser(kit, {
      email: 'inside@example.test',
      password: 'oldPassword123',
    })
    await kit.db
      .from('users')
      .where('id', inside.id)
      .update({ unverified_email: 'inside@outside.test' })
    assert.isTrue(await admission.isAdmitted(inside.id))

    const outside = await insertUser(kit, {
      email: 'outside@outside.test',
      password: 'oldPassword123',
    })
    await issueEmailChange(account, outside, recorder, 'outside@example.test')
    assert.isFalse(await admission.isAdmitted(outside.id))
  })

  test('a confirmed change to an outside domain loses admission on the next check', async ({
    assert,
  }) => {
    const recorder = makeNotify()
    const { admission, account } = makeAdmission(kit, requirementConfig.domain, {
      minRequestMs: 0,
      notify: recorder.notify,
    })
    const person = await insertUser(kit, { password: 'oldPassword123' })
    assert.isTrue(await admission.isAdmitted(person.id))
    const token = await issueEmailChange(account, person, recorder, 'person@outside.test')
    await account.emailPasswordManagement.completeEmailChange({ token })
    assert.isFalse(await admission.isAdmitted(person.id))
  })

  test('isAdmitted reads the stored row and is false for an unknown user', async ({ assert }) => {
    const config: AdmissionConfig = {
      ...requirementConfig.invitation,
      ...requirementConfig.approval,
    }
    const { admission } = makeAdmission(kit, config)
    const person = await insertUser(kit)
    assert.isFalse(await admission.isAdmitted(person.id))
    await writeAdmissionRow(kit, person.id, { invited: true })
    assert.isFalse(await admission.isAdmitted(person.id))
    await writeAdmissionRow(kit, person.id, { invited: true, approval: 'approved' })
    assert.isTrue(await admission.isAdmitted(person.id))
    await kit.db.transaction(async (trx) => {
      assert.isTrue(await admission.isAdmitted(person.id, trx))
    })
    assert.isFalse(await admission.isAdmitted(999_999))
  })

  test('eligibleDomain checks an address without throwing', async ({ assert }) => {
    const { admission } = makeAdmission(kit, {
      domain: { allowed: ['example.test'], includeSubdomains: true },
    })
    assert.isTrue(admission.eligibleDomain(' Person@Mail.Example.TEST '))
    assert.isFalse(admission.eligibleDomain('person@outside.test'))
    assert.isFalse(admission.eligibleDomain('a@b@example.test'))
    assert.isFalse(admission.eligibleDomain(42 as never))
    const { admission: open } = makeAdmission(kit, requirementConfig.approval)
    assert.isTrue(open.eligibleDomain('anything@anywhere.test'))
  })
})
