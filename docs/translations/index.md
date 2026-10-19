# Translations

Community translations of the Account Kit messages, ready to copy. They are documentation only:
the package ships no translation files and no loader.

## Use a translation

1. Set up [`@adonisjs/i18n`](https://docs.adonisjs.com/guides/digging-deeper/i18n) as described in
   [managed HTTP](../managed-http.md#error-messages-follow-the-application-s-language).
2. Open the page for your locale and copy each block into `resources/lang/<locale>/` under the
   file name in its title, merging it with any file of that name you already have.
3. Edit the wording as you like. The application owns its language.

## Locales

None yet. The English source is the `errors.json` and `validator.json` blocks in
[managed HTTP](../managed-http.md#error-messages-follow-the-application-s-language).

## Add a locale

Create `docs/translations/<locale>.md` with one titled block per file, then follow
[Adding a translation](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/CONTRIBUTING.md#adding-a-translation):

````md
# French (fr)

```json [errors.json]
{ "E_ACCOUNT_KIT_THROTTLED": "Trop de requêtes.", "…": "…" }
```

```json [validator.json]
{ "shared": { "messages": { "…": "…" }, "fields": { "…": "…" } } }
```
````

A test checks that every locale page has the same keys and `{placeholders}` as English and that each
value is valid ICU. It does not check wording.
