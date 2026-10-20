import vine from '@vinejs/vine'

export const admissionListValidator = vine.create({
  status: vine.enum(['pending', 'approved', 'rejected', 'revoked'] as const).optional(),
  limit: vine.number().min(1).max(100).optional(),
  cursor: vine.string().optional(),
})
