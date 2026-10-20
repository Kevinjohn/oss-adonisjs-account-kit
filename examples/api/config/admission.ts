import env from '#start/env'
import { defineAdmission } from 'adonisjs-account-kit/admission'
import { admissionAuthorize } from '#services/account_kit_authorization'

// Comma-separated, for example `example.com,example.org`; unset leaves the domain requirement off.
const domains = (env.get('ACCOUNT_KIT_ADMISSION_DOMAINS') ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean)

export default defineAdmission({
  ...(domains.length > 0 ? { domain: { allowed: domains } } : {}),
  invitation: { required: true },
  approval: { required: true, authorize: admissionAuthorize },
})
