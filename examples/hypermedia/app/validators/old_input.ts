import vine from '@vinejs/vine'

// Recover only bounded display fields; malformed values are discarded before validation.
const displayField = () =>
  vine
    .string()
    .parse((value) => {
      if (value === null) return ''
      return typeof value === 'string' && value.length <= 320 ? value : undefined
    })
    .optional()

export const oldInputValidator = vine.create({
  fullName: displayField(),
  email: displayField(),
})
