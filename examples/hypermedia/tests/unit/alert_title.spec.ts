import { test } from '@japa/runner'
import edge from 'edge.js'

test('an alert title escapes its text prop and keeps slot markup', async ({ assert }) => {
  const fromText = await edge.renderRaw("@!alert.title({ text: '<b>bold</b>' })")
  assert.include(fromText, '&lt;b&gt;bold&lt;/b&gt;')
  assert.notInclude(fromText, '<b>')
  const fromSlot = await edge.renderRaw('@alert.title()\n<b>bold</b>\n@end')
  assert.include(fromSlot, '<b>bold</b>')
})
