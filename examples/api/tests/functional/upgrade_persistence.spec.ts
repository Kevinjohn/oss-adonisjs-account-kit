import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import hash from '@adonisjs/core/services/hash'
import db from '@adonisjs/lucid/services/db'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import User from '#models/user'
import { notifications } from '#services/account_kit_notifications'

const email = 'upgrade-marker@example.test'
const customMigration = 'database/migrations/1791906000000_create_role_assignments'
const phase = process.env.ACCOUNT_KIT_UPGRADE_PHASE
const resetProofPath = app.tmpPath('upgrade-password-reset-proof.json')

interface ResetProof {
  token: string
  row: {
    id: number
    user_id: number
    email: string
    token_hash: string
    expires_at: string
    created_at: string
  }
}

function expiryIso(value: Date | string): string {
  const expiry = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(expiry.getTime())) throw new Error('The reset-token expiry was not a valid date')
  return expiry.toISOString()
}

if (phase && phase !== 'baseline' && phase !== 'candidate') {
  throw new Error(`Unknown ACCOUNT_KIT_UPGRADE_PHASE: ${phase}`)
}

if (phase === 'baseline') {
  test('records account data and a pending reset proof before upgrade', async ({
    assert,
    client,
  }) => {
    notifications.reset()
    await db.from('role_assignments').where('role', 'owner').delete()
    await User.query().where('email', email).delete()
    const user = await User.create({
      fullName: 'Existing User',
      email,
      password: 'ExistingPass123!',
    })
    await db.table('role_assignments').insert({ user_id: user.id, role: 'owner' })
    assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())

    const requested = await client.post('/api/v1/auth/password-reset').json({ email })
    assert.equal(requested.status(), 202)
    const notice = notifications.events.find((event) => event.kind === 'recovery')
    assert.isNotNull(notice)
    if (!notice) throw new Error('The baseline adapter did not deliver a recovery notice')
    const token = decodeURIComponent(new URL(notice.value).pathname.split('/').at(-1)!)
    const path = `/api/v1/auth/password-reset/${encodeURIComponent(token)}`
    const inspected = await client.get(path)
    assert.equal(inspected.status(), 200)
    const reset = await client.post(path).json({
      password: 'BaselineReset123!',
      passwordConfirmation: 'BaselineReset123!',
    })
    assert.equal(reset.status(), 202)
    await user.refresh()
    assert.equal(user.fullName, 'Existing User')
    assert.equal(user.email, email)
    assert.isTrue(await hash.verify(user.password!, 'BaselineReset123!'))

    const pendingRequest = await client.post('/api/v1/auth/password-reset').json({ email })
    assert.equal(pendingRequest.status(), 202)
    const persistedNotice = notifications.events.findLast((event) => event.kind === 'recovery')
    assert.isNotNull(persistedNotice)
    if (!persistedNotice) throw new Error('The baseline adapter did not deliver a reset notice')
    const persistedToken = decodeURIComponent(
      new URL(persistedNotice.value).pathname.split('/').at(-1)!
    )
    const row = await db.from('account_recovery_tokens').where('user_id', user.id).first()
    assert.isNotNull(row)
    if (!row) throw new Error('The baseline adapter did not persist the reset token')
    const proof: ResetProof = {
      token: persistedToken,
      row: {
        id: Number(row.id),
        user_id: Number(row.user_id),
        email: row.email,
        token_hash: row.token_hash,
        expires_at: expiryIso(row.expires_at),
        created_at: expiryIso(row.created_at),
      },
    }
    await mkdir(dirname(resetProofPath), { recursive: true })
    await writeFile(resetProofPath, JSON.stringify(proof), { mode: 0o600 })
    await chmod(resetProofPath, 0o600)
  })
}

if (phase === 'candidate') {
  test('preserves working account behavior, data, and application migrations across upgrade', async ({
    assert,
    client,
  }) => {
    const user = await User.findBy('email', email)
    assert.isNotNull(user)
    assert.equal(user!.fullName, 'Existing User')
    assert.isTrue(await hash.verify(user!.password!, 'BaselineReset123!'))
    const role = await db.from('role_assignments').where('user_id', user!.id).first()
    assert.equal(role?.role, 'owner')
    assert.isNotNull(await db.from('adonis_schema').where('name', customMigration).first())

    let proof: ResetProof
    try {
      proof = JSON.parse(await readFile(resetProofPath, 'utf8')) as ResetProof
    } finally {
      await rm(resetProofPath, { force: true })
    }
    const row = await db.from('password_reset_tokens').where('id', proof.row.id).first()
    assert.isNotNull(row)
    if (!row) throw new Error('The upgraded password-reset token row was not preserved')
    assert.equal(Number(row.id), proof.row.id)
    assert.equal(Number(row.tokenable_id), proof.row.user_id)
    assert.equal(row.email, proof.row.email)
    assert.equal(row.hash, proof.row.token_hash)
    assert.equal(expiryIso(row.expires_at), proof.row.expires_at)
    assert.equal(expiryIso(row.created_at), proof.row.created_at)

    const path = `/api/v1/auth/password-reset/${encodeURIComponent(proof.token)}`
    const inspected = await client.get(path)
    assert.equal(inspected.status(), 200)
    const reset = await client.post(path).json({
      password: 'UpgradeReset123!',
      passwordConfirmation: 'UpgradeReset123!',
    })
    assert.equal(reset.status(), 202)
    const replay = await client.post(path).json({
      password: 'UpgradeReset123!',
      passwordConfirmation: 'UpgradeReset123!',
    })
    assert.equal(replay.status(), 400)
    await user!.refresh()
    assert.isTrue(await hash.verify(user!.password!, 'UpgradeReset123!'))
  })
}
