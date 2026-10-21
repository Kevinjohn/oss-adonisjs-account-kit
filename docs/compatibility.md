# Compatibility and validation

This is an unpublished `0.0.0` candidate. The table records concrete tested points and declared
peer ranges separately; testing one point does not verify every version in a range.

| Component             | Tested point | Declared support                             |
| --------------------- | ------------ | -------------------------------------------- |
| Node.js               | 24.21.0      | `>=24.0.0`                                   |
| pnpm                  | 11.23.0      | Repository package manager                   |
| `@adonisjs/core`      | 7.6.0        | peer `^7.0.0`                                |
| `@adonisjs/lucid`     | 22.4.2       | peer `^22.4.2`                               |
| `@adonisjs/limiter`   | 3.0.1        | peer `^3.0.0`                                |
| Luxon                 | 3.7.2        | peer `^3.0.0`                                |
| `@adonisjs/assembler` | 8.5.2        | optional peer `^8.0.0` for configure tooling |

The package minimum matrix uses Core 7.0.0, assembler 8.0.0, Lucid 22.4.2, limiter 3.0.0 and
Luxon 3.0.0. Lucid 22.0.0 fails password reset issuance on both databases because its transaction
insert builder does not expose `onConflict`; the supported floor is therefore 22.4.2. The complete
HTTP reference application uses the latest compatible set, including Core 7.6.0 and assembler
8.5.2. Concrete installed-consumer outcomes are recorded in [verification](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/maintainers/verification.md).
Testing these points does not verify every version within the declared ranges. The
`pg`, `mysql2` and `better-sqlite3` drivers are supplied by applications and depend on the selected Lucid
dialect; the package does not declare them as runtime peers.

## Database expectations

SQLite and PostgreSQL 16 are supported. MySQL 8.4 (through `mysql2`) is experimental: the suite
passes on it, but CI does not run it on every change. Account access inspection was verified on
native MySQL 8.4.13; see the dated [verification record](maintainers/verification.md#account-access-inspection). The generated schema uses integer user IDs by default; run
configure with `--user-id-type=string` or `--user-id-type=uuid` when appropriate. Match the generated
foreign-key column types to the application schema and inspect all migrations before running them.
The package requires a unique email constraint and normalized lowercase storage. PostgreSQL
duplicate classification discovers a single-column email unique index from the catalog by default;
configure `emailConstraint` when relying on a custom constraint name. The Lucid adapter derives the
model's table and requires the physical primary-key column to be `id` on the default connection.

SQLite applications must enable foreign keys on every connection. Package writes acquire a
package-owned transaction lock using `account_transaction_lock`; the fifth configure migration
creates this table. SQLite write-contention retries can rerun transaction callbacks, so callbacks
must be safe to repeat. PostgreSQL and MySQL do not retry transactions. See
[transaction guidance](usage.md#transactions-and-callbacks).

### MySQL 8.4 (experimental)

- Use the `mysql2` client with `timezone: 'Z'`, and run every connection at the UTC session time
  zone, either with `default-time-zone = '+00:00'` on the server or in the pool's `afterCreate`:

  ```ts
  mysql: {
    client: 'mysql2',
    connection: { host, port, user, password, database, timezone: 'Z' },
    pool: {
      afterCreate(connection, done) {
        connection.query("set time_zone = '+00:00'", (error) => done(error, connection))
      },
    },
  }
  ```

  Without `timezone: 'Z'` (or `'+00:00'`), every Account Kit operation throws before it starts.

- Account Kit writes and compares timestamps as UTC `yyyy-MM-dd HH:mm:ss.SSS`, because MySQL
  rejects ISO 8601 values with a `Z` offset. `credentials_changed_at` keeps milliseconds so two
  credential changes in the same second still revoke the earlier session.
- Package transactions run at `READ COMMITTED`, so reads after the user row lock see the latest
  committed rows.
- Integer user IDs must be `unsigned`, as Lucid's `increments` creates them; the generated foreign
  keys are unsigned. Otherwise use `--user-id-type=string` or `uuid`.
- Social provider subjects are stored with the `utf8mb4_0900_bin` collation, so subjects that
  differ only by case, accent or trailing space stay distinct. A string `users.id` should use the
  same binary collation; the foreign-key columns follow the table's default collation and must
  match it.
- The generated `timestamp` columns are MySQL `TIMESTAMP`, which ends in January 2038.
- MariaDB is not supported.

## Dependency audit assessment

Audits of the candidate and the fresh SQLite consumer install were run on 2026-10-14 with pnpm
11.23.0 under Node 24.21.0. The candidate's full audit reported 16 advisories (7 high, 6 moderate,
3 low, no critical); all were development-tool paths. Fourteen advisories affect `undici 6.23.0`
through `release-it 19.2.4` and `@release-it/conventional-changelog 10.0.6`. Their IDs are
GHSA-f269-vfmq-vjvj, GHSA-2mjp-6q6p-2qxm, GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8,
GHSA-4992-7rv2-5pvq, GHSA-p88m-4jfj-68fv, GHSA-vxpw-j846-p89q, GHSA-g8m3-5g58-fq7m,
GHSA-8xcm-r25x-g524, GHSA-m8rv-5g2x-5cg5, GHSA-v3r7-h72x-cjcm, GHSA-35p6-xmwp-9g52,
GHSA-r53p-7pc4-xj5r, and GHSA-rfgv-xxqx-mfg5. The audit lists fixes from `undici 6.24.0` to
`6.28.1`; `6.28.1` satisfies all listed ranges. `basic-ftp 5.3.1` has high advisory
[GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r), via the same release-tool
tree, with a patched version listed at `6.2.1`.

The consumer audit changes the previous production-risk assessment: its full audit and
`pnpm audit --prod` each report high advisory
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) in `braces 3.0.3`, with no
patched version published in the audit data. The path is through the optional Adonis assembler
peer, then `fast-glob > micromatch > braces`; the consumer uses assembler `8.5.2`. Although
assembler is a build/configuration tool and the inspected `fast-glob` call handles configured
metadata-file globs during build, the consumer's production audit still reports this optional-peer
path. The trace did not find an account-request-time path from account inputs to that parser. This
does not assess arbitrary application use of the parser or attacker-controlled build configuration.

The exact minimum installation separately reports two high and one moderate advisory, including
`braces` above. Luxon `3.0.0` has high
[GHSA-3xq5-wjfh-ppjc](https://github.com/advisories/GHSA-3xq5-wjfh-ppjc), affecting untrusted inputs
to `DateTime.fromRFC2822`; the patched 3.x floor is `3.2.1`. Core `7.0.0` has moderate
[GHSA-6qvv-pj99-48qm](https://github.com/advisories/GHSA-6qvv-pj99-48qm), affecting
`response.redirect().back()` and `response.redirect('back')`. Its metadata lists Core `7.3.1` as
patched, while its remediation recommends `^7.4.0`. Account Kit does not call the affected Luxon
method, and the API reference returns JSON without these redirects. This trace does not assess
other consumer application code. Compatibility floors describe verified behavior, not a security
guarantee: use the tested latest-compatible Core `7.6.0` and Luxon `3.7.2` for production rather
than the older minimum test points. Those latest versions have neither direct advisory; the
optional assembler and release-tool advisories above remain unresolved.

The candidate's `pnpm audit --prod` reports no dependencies because runtime packages are peers;
that result alone does not assess a consumer installation. Consumers should audit their complete
installed tree, including resolved peers. No dependency was upgraded for this assessment. See
[verification](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/maintainers/verification.md) for check evidence.

Earlier stage-by-stage manual-check notes remain in [manual-check.md](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/maintainers/manual-check.md) as historical
provenance. Use the maintained verification record for current checks and outstanding evidence.
