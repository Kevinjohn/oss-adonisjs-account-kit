# Decisions

## Departures

1. **Aligning ([conventions #24](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/24))** — IMP-5. `bin/demos/overlay/config/account_kit.ts` and `bin/demos/overlay/start/account_kit_routes.ts` are application files: the demo script copies them into a generated application, whose `imports` map resolves their `#` aliases. The package itself imports by relative path.
2. VOC-1. `authentication.sessions.*`, the `sessions.revoked` event and `SessionsRevokedContext` name every place a user is signed in "sessions", including access-token rows under the access-token strategy. The names stay as they are.
3. **Aligning** — PKG-35. `src/transaction.ts` keeps the result of a committed operation in the module-level `WeakMap` `committedResults`. Blocker: the code keeps it off the public error on purpose ("Internal operation data is retained privately, never placed on a public committed error"), and a private field on `E_ACCOUNT_KIT_POST_COMMIT` would change its exported declaration in `./errors` to a nominal type.
4. **Aligning** — PKG-35. `src/http/session_store_protection.ts` keeps the requests whose session store was verified in the module-level `WeakMap` `verifiedRequests`. Blocker: the public `createManagedGuard(options)` (`./http`) builds the guard that reads it, and the guard's `forRequest` is synchronous, so it cannot resolve a provider-created instance from the container. Passing one in changes the public options of `createManagedGuard` or `protectManagedSessionConfig`.
