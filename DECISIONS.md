# Decisions

## Departures

1. **Aligning ([conventions #24](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/24))** — IMP-5. `bin/demos/overlay/config/account_kit.ts` and `bin/demos/overlay/start/account_kit_routes.ts` are application files: the demo script copies them into a generated application, whose `imports` map resolves their `#` aliases. The package itself imports by relative path.
2. VOC-1. `authentication.sessions.*`, the `sessions.revoked` event and `SessionsRevokedContext` name every place a user is signed in "sessions", including access-token rows under the access-token strategy. The names stay as they are.
