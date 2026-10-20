import { useEffect, useRef } from 'react'

type Field = { name: string; label: string }

type Props = {
  errors: Record<string, string | undefined>
  fields: readonly Field[]
}

/** The form callback also refocuses a summary when the same error is returned twice. */
export function focusFormErrorSummary() {
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('[data-form-error-summary]')?.focus()
  )
}

/** Field errors get a focus target; form-level flash messages remain in the toast. */
export default function FormErrorSummary({ errors, fields }: Props) {
  const summary = useRef<HTMLDivElement>(null)
  const invalidFields = fields.filter(({ name }) => Boolean(errors[name]))
  const hasErrors = invalidFields.length > 0

  useEffect(() => {
    if (hasErrors) summary.current?.focus()
  }, [errors, hasErrors])

  if (!hasErrors) return null

  return (
    <div ref={summary} role="alert" tabIndex={-1} className="field__error" data-form-error-summary>
      <p>Check these fields:</p>
      <ul>
        {invalidFields.map(({ name, label }) => (
          <li key={name}>
            <a className="il" href={`#${name}`}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
