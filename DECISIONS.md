# Decisions

## Departures

1. VOC-1. `authentication.sessions.*`, the `sessions.revoked` event and `SessionsRevokedContext` name every place a user is signed in "sessions", including access-token rows under the access-token strategy. The names stay as they are.
