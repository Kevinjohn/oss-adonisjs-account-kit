// Credential changes: re-exports the password-change, email-change and profile-update modules.
export { changePassword } from './change_password.js'
export { completeEmailChange, inspectEmailChange } from './email_change.js'
export { requestEmailChange, updateProfile } from './profile_update.js'
