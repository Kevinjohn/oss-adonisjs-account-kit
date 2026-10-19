# Custom user model

The Lucid adapter works with your existing `User` model. It needs a few columns and one rule about
email addresses.

## Required columns

| Model property    | Column              | Notes                                                  |
| ----------------- | ------------------- | ------------------------------------------------------ |
| `id`              | `id`                | The physical primary key. Integer, string or UUID.     |
| `email`           | `email`             | Trimmed, lowercase, with a single-column unique index. |
| `password`        | `password`          | Nullable. `null` means no local password.              |
| `unverifiedEmail` | `unverified_email`  | Nullable. Added by the package migrations.             |
| `emailVerifiedAt` | `email_verified_at` | Nullable. Added by the package migrations.             |

Session and token login also use `credentials_changed_at`, added by the migrations. Run
`node ace account-kit:doctor` to confirm the table matches.

## Extra profile fields at signup

Account Kit never copies request fields onto your model. Two callbacks handle extra fields:

1. `registration.mapFields` turns untrusted input into an allowlisted object. It runs at signup,
   invitation acceptance, social registration and profile updates. Protected fields such as
   `email`, `password` and `role` are rejected even if you return them.
2. The Lucid adapter's `mapRegistrationData` copies that object onto the model.

```ts
// config/account_kit.ts
const loadUser = async () => {
  const { default: User } = await import('#models/user')
  return User
}

const users = createLucidAdapter(loadUser, {
  mapRegistrationData(data, user) {
    user.fullName = (data as { fullName: string }).fullName
  },
})

export default defineConfig({
  users,
  registration: {
    availability: 'open',
    mapFields(data) {
      const fullName = (data as { fullName?: unknown } | null)?.fullName
      if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 100)
        throw new Error('A full name of at most 100 characters is required')
      return { fullName: fullName.trim() }
    },
  },
  // ...
})
```

## Hashing

The adapter saves passwords through the model, so your `withAuthFinder` or `beforeSave` hashing
runs as usual. Account Kit never writes a plain password to the database.

## A different table or ID type

See [custom user table or ID type](../custom-schema.md).

## Not using Lucid

Write your own adapter: see [custom adapter](custom-adapter.md).
