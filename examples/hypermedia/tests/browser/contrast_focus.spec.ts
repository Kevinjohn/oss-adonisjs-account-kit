import { test } from '@japa/runner'
import type { BasePage } from '@japa/browser-client'
import { DateTime } from 'luxon'
import HttpExceptionHandler from '#exceptions/handler'
import User from '#models/user'
import { setupAccountDatabase } from '#tests/helpers/account_database'

const origin = process.env.APP_URL!

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.map(Number)
    if (channels.length === 4 && channels[3] !== 1) throw new Error(`Non-opaque color: ${color}`)
    const linear = channels.slice(0, 3).map((channel) => {
      const value = channel / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

type Locator = ReturnType<BasePage['page']['locator']>
type RenderedElement = {
  parentElement: RenderedElement | null
  matches: (selector: string) => boolean
}

async function renderedStyles(locator: Locator) {
  return locator.evaluate((rawElement) => {
    const element = rawElement as unknown as RenderedElement
    const computedStyle = (
      globalThis as unknown as {
        getComputedStyle: (target: RenderedElement) => Record<string, string>
      }
    ).getComputedStyle.bind(globalThis)
    const style = computedStyle(element)
    let parent = element.parentElement
    let surrounding = 'rgba(0, 0, 0, 0)'
    while (surrounding === 'rgba(0, 0, 0, 0)' && parent) {
      surrounding = computedStyle(parent).backgroundColor
      parent = parent.parentElement
    }
    return {
      foreground: style.color,
      background:
        style.backgroundColor === 'rgba(0, 0, 0, 0)' ? surrounding : style.backgroundColor,
      surrounding,
      focused: element.matches(':focus'),
      focusVisible: element.matches(':focus-visible'),
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineStyle: style.outlineStyle,
    }
  })
}

test.group('rendered label contrast and keyboard button focus', (group) => {
  group.each.setup(setupAccountDatabase)

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} status labels meet small-text contrast on their actual surfaces`, async ({
      browser,
      assert,
    }) => {
      const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' })
      const notFoundPath = '/contrast-check-missing-page'
      const originalRender = HttpExceptionHandler.prototype.renderErrorAsHTML
      // Exercise the production 404 template; test mode normally renders a debug error page.
      HttpExceptionHandler.prototype.renderErrorAsHTML = async function (error, ctx) {
        const handler = this as unknown as { renderStatusPages: boolean }
        const previous = handler.renderStatusPages
        if (ctx.request.url() === notFoundPath) handler.renderStatusPages = true
        try {
          return await originalRender.call(this, error, ctx)
        } finally {
          handler.renderStatusPages = previous
        }
      }
      try {
        await context.addCookies([{ name: 'app_theme', value: theme, url: origin }])
        const page = await context.visit('/')
        for (const label of ['Built with', 'Server ready']) {
          const tag = page.locator('.tag').filter({ hasText: label })
          await tag.waitFor()
          const colors = await renderedStyles(tag)
          assert.isAtLeast(contrast(colors.foreground, colors.background), 4.5, label)
        }
        const response = await page.goto(notFoundPath)
        assert.equal(response?.status(), 404)
        const notFound = page.locator('.tag').filter({ hasText: '404' })
        await notFound.waitFor()
        const colors = await renderedStyles(notFound)
        assert.isAtLeast(contrast(colors.foreground, colors.background), 4.5, '404 inline color')
      } finally {
        HttpExceptionHandler.prototype.renderErrorAsHTML = originalRender
        await context.close()
      }
    })

    test(`${theme} primary, ghost and secondary buttons expose a contrasting keyboard outline`, async ({
      browser,
      assert,
    }) => {
      const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' })
      try {
        await context.addCookies([{ name: 'app_theme', value: theme, url: origin }])
        const page = await context.visit('/')
        const checkFocus = async (selector: string) => {
          const button = page.locator(selector)
          // Reach the real control through sequential keyboard navigation, not programmatic focus.
          for (let step = 0; step < 15; step++) {
            await page.keyboard.press('Tab')
            const state = await renderedStyles(button)
            if (state.focused) break
          }
          const focus = await renderedStyles(button)
          assert.isTrue(focus.focusVisible, selector)
          assert.equal(focus.outlineStyle, 'solid')
          assert.isAtLeast(Number.parseFloat(focus.outlineWidth), 3)
          assert.isAtLeast(Number.parseFloat(focus.outlineOffset), 3)
          assert.isAtLeast(contrast(focus.outlineColor, focus.surrounding), 3, selector)
        }
        await checkFocus('.btn--ghost')
        await checkFocus('.btn--primary')
        const user = await User.create({
          email: `focus-${theme}@example.test`,
          password: 'FocusPassword123!',
          emailVerifiedAt: DateTime.now(),
          unverifiedEmail: null,
        })
        await page.goto('/login')
        await page.getByLabel('Email').fill(user.email)
        await page.getByLabel('Password', { exact: true }).fill('FocusPassword123!')
        await page.getByRole('button', { name: 'Sign in' }).click()
        await page.getByRole('heading', { name: 'Your account' }).waitFor()
        await checkFocus('.btn--secondary')
      } finally {
        await context.close()
      }
    })
  }
})
