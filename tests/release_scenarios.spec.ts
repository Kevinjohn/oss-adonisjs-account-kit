import { test } from '@japa/runner'
import { renderAccountMessage } from '../src/notifications.js'

test('maintained action emails keep brand, instructions, and link in reading order', ({
  assert,
}) => {
  const actions = [
    ['passwordResetProvision', 'Reset password'],
    ['accountActivationProvision', 'Confirm email address'],
    ['invitationProvision', 'Accept invitation'],
    ['emailChangeProvision', 'Confirm new email address'],
  ] as const

  for (const [kind, label] of actions) {
    const rendered = renderAccountMessage(kind, {
      brandName: 'Account Team',
      actionUrl: 'https://example.test/action',
    })
    const htmlOrder = [
      rendered.html.indexOf('>Account Team</p>'),
      rendered.html.indexOf('<h1>'),
      rendered.html.indexOf('<p>Use the link below'),
      rendered.html.indexOf('<a href='),
      rendered.html.indexOf(`>${label}</a>`),
      rendered.html.indexOf('Or copy this link:'),
    ]
    const textOrder = [
      rendered.text.indexOf('Account Team'),
      rendered.text.indexOf('\n\n', rendered.text.indexOf('Account Team')),
      rendered.text.indexOf('Use the link below'),
      rendered.text.indexOf(label),
      rendered.text.indexOf('https://example.test/action'),
    ]

    assert.isTrue(htmlOrder.every((index) => index >= 0))
    assert.isTrue(
      htmlOrder.every((index, position) => position === 0 || htmlOrder[position - 1]! < index)
    )
    assert.isTrue(textOrder.every((index) => index >= 0))
    assert.isTrue(
      textOrder.every((index, position) => position === 0 || textOrder[position - 1]! < index)
    )
  }
})
