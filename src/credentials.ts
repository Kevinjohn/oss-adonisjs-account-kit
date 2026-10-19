// Credential changes: re-exports the password-change and email-change modules.
export { changePassword } from './change_password.js'
export {
  completeEmailChange,
  inspectEmailChange,
  requestEmailChange,
  updateProfile,
} from './email_change.js'
