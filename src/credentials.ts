// Credential changes: re-exports the password-change, email-change and profile-update modules.
export { changePassword } from './change_password.ts'
export { completeEmailChange, inspectEmailChange } from './email_change.ts'
export { requestEmailChange, updateProfile } from './profile_update.ts'
