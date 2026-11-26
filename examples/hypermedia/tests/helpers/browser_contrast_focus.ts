import type { BasePage } from '@japa/browser-client'

export const origin = process.env.APP_URL!

export function contrast(foreground: string, background: string) {
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

export type Locator = ReturnType<BasePage['page']['locator']>
export type RenderedElement = {
  parentElement: RenderedElement | null
  matches: (selector: string) => boolean
}

export async function renderedStyles(locator: Locator) {
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
