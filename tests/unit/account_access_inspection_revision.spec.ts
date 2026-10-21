import { test } from '@japa/runner'
import { readInspectionRevision } from '../../src/account_access_inspection.js'

for (const [name, row] of [
  ['absent row', undefined],
  ['absent column', {}],
  ['undefined column', { credentials_changed_at: undefined }],
] as const) {
  test(`inspection revision rejects ${name}`, ({ assert }) => {
    assert.throws(
      () => readInspectionRevision(row),
      'account_kit: credentials_changed_at is missing from the inspected account row'
    )
  })
}
test('inspection revision preserves initial SQL null', ({ assert }) => {
  assert.isNull(readInspectionRevision({ credentials_changed_at: null }))
})
test('inspection revision rejects unreadable timestamps', ({ assert }) => {
  assert.throws(
    () => readInspectionRevision({ credentials_changed_at: 'garbage' }),
    'account_kit: unreadable timestamp value'
  )
})
test('inspection revision canonicalizes Date values', ({ assert }) => {
  assert.equal(
    readInspectionRevision({ credentials_changed_at: new Date(0) }),
    '1970-01-01T00:00:00.000Z'
  )
})
