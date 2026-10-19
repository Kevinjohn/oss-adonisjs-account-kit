# Translations

Account Kit ships English messages only. When the application uses `@adonisjs/i18n`, the managed
routes look up their error and validation messages through it, so the application owns every
other language (see "Error messages follow the application's language" in
[managed HTTP](../managed-http.md)).

The community keeps ready-to-copy translations here, one page per locale, so an application does
not have to write them from scratch. Each page has an `errors.json` and a `validator.json` block.
Copy each block into `resources/lang/<locale>/` in your application, merging it with any file of
the same name you already have. No runtime translation resources or loader are added to the
package.

The English blocks on that page are the source. A test checks that every locale page has the same
keys and placeholders, so a page stays complete when messages change.

## Locales

None yet. To add one, see "Adding a translation" in the repository's `CONTRIBUTING.md`.
