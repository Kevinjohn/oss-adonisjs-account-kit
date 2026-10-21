export function focusFormErrorSummary() {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-form-error-summary]')?.focus()
  )
}
