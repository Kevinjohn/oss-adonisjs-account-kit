import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { AppFactory } from '@adonisjs/core/factories/app'
import { EmitterFactory } from '@adonisjs/core/factories/events'
import { I18nManager, defineConfig, formatters, loaders } from '@adonisjs/i18n'
import {
  createMailNotifications,
  renderAccountMessage,
  type AccountMessageKind,
  type RenderedAccountMessage,
} from '../src/notifications.js'
import type { AccountKitTranslator } from '../src/translator.js'

/** Output captured before emails became translatable; output without `i18n` must not change. */
const english: Record<
  AccountMessageKind,
  { plain: RenderedAccountMessage; layout: RenderedAccountMessage }
> = JSON.parse(await readFile(new URL('./fixtures/english_emails.json', import.meta.url), 'utf8'))
const kinds = Object.keys(english) as AccountMessageKind[]
const values = {
  brandName: 'Acme & <Co>',
  actionUrl: 'https://app.example.test/a?token=x&y="1"',
  providerName: 'Google <Workspace>',
}
const layout = (body: string) => `<div class="layout">${body}</div>`
const actionKinds = new Set<AccountMessageKind>([
  'passwordResetProvision',
  'accountActivationProvision',
  'invitationProvision',
  'emailChangeProvision',
  'magicLinkProvision',
])

function recorder(answer: (identifier: string, fallback: string) => string, locale = 'fr') {
  const calls: Array<{ identifier: string; data: Record<string, unknown>; fallback: string }> = []
  const i18n: AccountKitTranslator = {
    locale,
    t(identifier, data, fallback) {
      calls.push({ identifier, data, fallback })
      return answer(identifier, fallback)
    },
  }
  return { i18n, calls }
}

test.group('translatable account emails', () => {
  test('output without i18n matches the English fixtures byte for byte', ({ assert }) => {
    assert.lengthOf(kinds, 11)
    for (const kind of kinds) {
      assert.deepEqual(renderAccountMessage(kind, values), english[kind].plain, kind)
      assert.deepEqual(renderAccountMessage(kind, values, layout), english[kind].layout, kind)
    }
  })

  test('every kind looks up its keys with brand, provider and URL data', ({ assert }) => {
    for (const kind of kinds) {
      const { i18n, calls } = recorder((identifier) => `[${identifier}]`)
      const message = renderAccountMessage(kind, values, undefined, { i18n })
      const parts = ['subject', 'heading', 'body', ...(actionKinds.has(kind) ? ['action'] : [])]
      assert.deepEqual(
        calls.map((call) => call.identifier),
        [
          ...parts.map((part) => `account_kit.emails.${kind}.${part}`),
          ...(actionKinds.has(kind) ? ['account_kit.emails.copy_link'] : []),
        ],
        kind
      )
      for (const call of calls)
        assert.deepEqual(call.data, {
          brandName: values.brandName,
          provider: values.providerName,
          url: values.actionUrl,
        })
      assert.equal(message.subject, `[account_kit.emails.${kind}.subject]`)
      assert.include(message.text, `[account_kit.emails.${kind}.heading]`)
      assert.include(message.text, `[account_kit.emails.${kind}.body]`)
      assert.include(message.html, `<h1>[account_kit.emails.${kind}.heading]</h1>`)
      assert.include(message.html, `<p>[account_kit.emails.${kind}.body]</p>`)
      if (actionKinds.has(kind)) {
        assert.include(message.text, `[account_kit.emails.${kind}.action]: ${values.actionUrl}`)
        assert.include(message.html, `>[account_kit.emails.${kind}.action]</a>`)
        assert.include(message.html, '<p>[account_kit.emails.copy_link]</p>')
      }
    }
  })

  test('missing keys fall back to the English text and only lang follows the locale', ({
    assert,
  }) => {
    for (const kind of kinds) {
      const { i18n, calls } = recorder((_identifier, fallback) => fallback)
      const plain = renderAccountMessage(kind, values, undefined, { i18n })
      assert.deepEqual(
        plain,
        {
          ...english[kind].plain,
          html: english[kind].plain.html.replace('<html lang="en">', '<html lang="fr">'),
        },
        kind
      )
      assert.notInclude(
        calls.map((call) => call.fallback).join('\n'),
        '{',
        'fallbacks are interpolated'
      )
      assert.deepEqual(
        renderAccountMessage(kind, values, layout, { i18n }),
        english[kind].layout,
        kind
      )
    }
  })

  test('escapes translated markup and the locale', ({ assert }) => {
    const { i18n } = recorder(() => '<b>"x"</b>', 'fr"><script>')
    const message = renderAccountMessage('passwordResetProvision', values, undefined, { i18n })
    assert.notInclude(message.html, '<b>')
    assert.notInclude(message.html, '<script>')
    assert.include(message.html, '<h1>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</h1>')
    assert.include(message.html, '<html lang="fr&quot;&gt;&lt;script&gt;">')
    assert.include(message.text, '<b>"x"</b>')
  })

  test('lang defaults to en when the translator has no locale', ({ assert }) => {
    const message = renderAccountMessage('passwordChanged', values, undefined, {
      i18n: { t: (_identifier, _data, fallback) => fallback },
    })
    assert.include(message.html, '<html lang="en">')
  })

  test('resolves an i18n function when a message is sent', async ({ assert }) => {
    let resolutions = 0
    const subjects: string[] = []
    const notify = createMailNotifications({
      mail: {
        async sendLater(callback) {
          const message = {
            to: () => message,
            from: () => message,
            subject: (subject: string) => (subjects.push(subject), message),
            html: () => message,
            text: () => message,
          }
          callback(message as never)
        },
      },
      from: 'accounts@example.test',
      brandName: 'Example',
      i18n: () => {
        resolutions++
        return recorder((identifier, fallback) =>
          identifier.endsWith('.subject') ? `Mot de passe ${resolutions}` : fallback
        ).i18n
      },
    })
    assert.equal(resolutions, 0)
    const context = { operation: 'password_change', operationId: '1', userId: 1 } as const
    const user = {
      id: 1,
      email: 'person@example.test',
      unverifiedEmail: null,
      hasPassword: true,
      emailVerifiedAt: null,
    }
    await notify.passwordChanged(user, context)
    await notify.passwordChanged(user, context)
    assert.deepEqual(subjects, ['Mot de passe 1', 'Mot de passe 2'])
  })
})

test.group('translatable account emails docs', () => {
  test('the documented account_kit.json matches the English templates', async ({ assert }) => {
    const docs = await readFile(
      new URL('../docs/recipes/email-templates.md', import.meta.url),
      'utf8'
    )
    const block = docs
      .split('resources/lang/<locale>/account_kit.json')[1]
      ?.match(/```json\n([\s\S]*?)```/)
    const documented = JSON.parse(block![1])
    const looked: Record<string, string> = {}
    for (const kind of kinds) {
      const { i18n, calls } = recorder((_identifier, fallback) => fallback)
      renderAccountMessage(kind, values, undefined, { i18n })
      for (const call of calls) {
        const path = call.identifier.replace('account_kit.', '').split('.')
        const message = path.reduce((node, key) => node?.[key], documented)
        assert.isString(message, call.identifier)
        looked[call.identifier] = message.replace(
          /\{(brandName|provider|url)\}/g,
          (_: string, name: string) => String(call.data[name])
        )
        assert.equal(looked[call.identifier], call.fallback, call.identifier)
      }
    }
    const documentedKeys = Object.entries(documented.emails).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [`account_kit.emails.${key}`]
        : Object.keys(value as object).map((part) => `account_kit.emails.${key}.${part}`)
    )
    assert.sameMembers(documentedKeys, Object.keys(looked))
  })
})

test.group('translatable account emails with @adonisjs/i18n', (group) => {
  let location: string
  group.each.setup(async () => {
    location = await mkdtemp(join(tmpdir(), 'account-kit-i18n-'))
    return () => rm(location, { recursive: true, force: true })
  })

  test('interpolates ICU placeholders and falls back to English verbatim', async ({ assert }) => {
    await mkdir(join(location, 'fr'))
    await writeFile(
      join(location, 'fr', 'account_kit.json'),
      JSON.stringify({
        emails: {
          socialIdentityLinked: {
            subject: 'Connexion {provider} ajoutée – {brandName}',
            body: 'La connexion {provider} a été ajoutée à votre compte.',
          },
          copy_link: 'Ou copiez ce lien : {url}',
        },
      })
    )
    const app = new AppFactory().create(new URL('./', import.meta.url))
    const emitter = new EmitterFactory().create(app)
    const config = await defineConfig({
      defaultLocale: 'en',
      formatter: formatters.icu(),
      loaders: [loaders.fs({ location })],
    }).resolver(app as never)
    const manager = new I18nManager(emitter, config)
    await manager.loadTranslations()
    const i18n = manager.locale('fr')

    const linked = renderAccountMessage('socialIdentityLinked', values, undefined, { i18n })
    assert.equal(linked.subject, 'Connexion Google <Workspace> ajoutée – Acme & <Co>')
    assert.include(linked.html, '<p>La connexion Google &lt;Workspace&gt; a été ajoutée')
    assert.include(linked.html, '<h1>A social sign-in method was linked</h1>')
    assert.include(linked.html, '<html lang="fr">')

    const reset = renderAccountMessage('passwordResetProvision', values, undefined, { i18n })
    assert.equal(reset.subject, english.passwordResetProvision.plain.subject)
    assert.include(
      reset.html,
      '<p>Ou copiez ce lien : https://app.example.test/a?token=x&amp;y=&quot;1&quot;</p>'
    )
  })
})
