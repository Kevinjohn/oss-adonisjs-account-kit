# Glossary

Words with a specific meaning in Account Kit, in alphabetical order.

**Action URL.** The link in an account email, for example a reset link. Built by the `urls`
callbacks, or by `createActionUrls` from configured origins only. It carries a proof token.

**Active account.** An account whose email address is confirmed. Routes that need it call
`requireActive`, or use the `active` access level in managed routes. See _limited account_.

**Admission.** Whether a verified account may use the application: an allowed email domain,
invitation evidence and approval, each optional. See [admission](admission.md). Compare
_registration availability_.

**Application-owned mode.** You write the routes and controllers and call the `AccountKit` service.
The default. Compare _managed mode_.

**Capability.** One feature area you switch on in `enabled`: `passwordReset`,
`emailVerification`, `emailPasswordManagement`, `invitations`, `registration` or
`socialAuthentication`. Calling a disabled capability throws `CapabilityDisabledError`.

**Client key.** A value that identifies the caller for rate limiting, usually `request.ip()` after
trusted proxies are configured. Never accept one from the request body.

**Committed.** A `PostCommitError` or `DeliveryError` means the database change already happened.
Do not run the operation again.

**Credential revision.** The `users.credentials_changed_at` timestamp. Every credential change
advances it, and sessions or tokens issued before the change stop working.

**Delivery classification.** How reliable your mail is: `best-effort` (default, no retry),
`durable` (your queue or outbox retries) or `capture` (development only, nothing is sent).

**Guard.** An existing AdonisJS Auth guard (`session` or `access_tokens`) that Account Kit signs
users in through. The package never creates one.

**Handoff code.** A single-use code, bound to a PKCE challenge, that moves a completed social
sign-in from the provider callback to your client.

**Inspect.** Check a proof link without using it up, for example to show a "set new password" form
only when the link is still valid. Every proof flow has `inspect` and a completing call.

**Lifecycle event.** A typed event such as `password.reset` or `invitation.accepted` passed to
`onLifecycleEvent` after commit. Useful for audit logs.

**Limited account.** Signed in but email not yet confirmed. It may fix its address or resend the
link but cannot use routes that need an _active account_.

**Managed mode.** Account Kit mounts its own JSON routes with `registerManagedRoutes`. You still
own the frontend, guard and policies. See [managed endpoints](reference/endpoints.md).

**Operation ID.** A UUID for one account operation, passed to hooks and events so you can correlate
logs and deduplicate retries.

**Pending email.** `users.unverified_email`: an address that has been requested but not confirmed.
For a new account it equals `email`.

**Pillar.** One of the six choice groups recorded by `account-kit:setup`: features, user model,
authentication, mail, social providers and policy.

**Proof token.** The random secret in an action URL. Only its SHA-256 hash is stored, it expires,
and it works once.

**Provision.** A notification that delivers a proof link: `passwordResetProvision`,
`accountActivationProvision`, `invitationProvision` and `emailChangeProvision`. Other
notifications are notices, such as `passwordChanged`.

**Recent proof.** Short-lived evidence that a user just re-entered their password, required before
sensitive social actions on accounts without a password.

**Registration availability.** Who may create an account: `registration.availability` is `open`,
`closed` or `application` (your code decides). Compare _admission_.

**Retirement.** Turning off a login method, such as password login or a social provider.
`account-kit:retirement-impact` counts the accounts that would lose their only way in.
