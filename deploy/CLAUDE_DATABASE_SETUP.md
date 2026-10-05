# Claude handoff — Smooth Coach PostgreSQL setup and driver migration

> **Status:** the application migration (steps 6–9 below) is done in the repository: the server uses `pg`, applies `deploy/postgres/smooth-coach-schema.sql` at startup, and was validated against PostgreSQL 16. Images published **before** that change (including the old `venturesconsulting/smooth-coach:latest`) still use `mysql2` and will **not** connect to PostgreSQL — deploy an image built from the migrated source.

Attach the two files in `deploy/postgres/` to Claude Code (or place them in the repository), then paste the prompt below.

---

## Prompt to give Claude

> You are preparing the Smooth Coach Docker application to use an existing **PostgreSQL 14+** database. Do not use MySQL and do not make unrelated infrastructure changes.
>
> ### Database provisioning
> 1. Confirm the target is PostgreSQL 14+ and identify the intended host, port, TLS/CA requirements, and the deployment network. Stop and ask if it is not PostgreSQL or if the target is unclear.
> 2. Use `deploy/postgres/setup-smooth-coach-postgres.sh` and `deploy/postgres/smooth-coach-schema.sql`. Obtain administrator and application passwords from the user’s secret manager or secure terminal input only.
> 3. Set the database name and app role only if the user specifies alternatives; otherwise use `smooth_coach` and `smooth_coach_app`.
> 4. Run the provisioning script once. It may create/alter only the named Smooth Coach role, database, schema objects, and privileges. Do not alter, delete, or inspect unrelated databases, roles, tables, or data.
> 5. Verify exactly four application tables exist, and that the app role can connect using the required TLS settings. Never print passwords, full credential-bearing URLs, or admin credentials.
>
> ### Required application migration
> 6. Update the Smooth Coach server from `mysql2/promise` to the `pg` package and use `DATABASE_URL=postgresql://...` at runtime. Preserve SSL support; use the deployment provider’s certificate guidance instead of globally disabling certificate validation unless the provider explicitly requires it.
> 7. Replace MySQL-only SQL syntax in `server/index.mjs` with PostgreSQL equivalents while preserving behavior:
>    - positional `?` parameters → `$1`, `$2`, etc.; use `result.rows`
>    - `ON DUPLICATE KEY UPDATE` → `ON CONFLICT (...) DO UPDATE`
>    - `DATE_FORMAT(date, '%Y-%m-%d')` → `to_char(date, 'YYYY-MM-DD')`
>    - `DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)` → `CURRENT_TIMESTAMP + INTERVAL '15 minutes'`
>    - `BIGINT AUTO_INCREMENT` is already represented by the provided PostgreSQL identity columns
>    - keep all account-scoping, foreign keys, and photo type/size verification intact
> 8. Do not mix the MySQL and PostgreSQL paths. After migration, remove the MySQL driver dependency and update any package lockfile.
> 9. Start the app with a PostgreSQL `DATABASE_URL`; validate `/api/health`, schema initialization, sign-in-required endpoints, a saved coach state, a weight entry, and a photo upload. Do not use production user data for testing.
> 10. Build the Docker image and publish a **new immutable version tag** only after validation. Do not overwrite `latest` without explicit user approval.
>
> ### Secrets and completion
> 11. Store the app connection string in the deployment secret manager in this form, URL-encoding the role/password as needed:
>
>     ```text
>     postgresql://SMOOTH_COACH_DB_USER:URL_ENCODED_PASSWORD@PG_ADMIN_HOST:5432/SMOOTH_COACH_DATABASE?sslmode=verify-full
>     ```
>
>     TLS is controlled entirely by this URL. `sslmode=verify-full` validates the server certificate against the system CAs. If the provider signs with its own CA (for example the RDS bundle), mount that PEM file into the container and add `&sslrootcert=/path/to/ca.pem`. Use `sslmode=no-verify` only if the provider explicitly requires it.
>
> 12. Report only: database host, port, database name, app role, schema verification result, migration/test status, and the new image tag/digest if one is published.

---

## Required secure environment variables for the provisioning script

Set these only in a secret-capable shell/session—not in a committed `.env` file:

```bash
export PG_ADMIN_HOST='your-postgresql-host'
export PG_ADMIN_USERNAME='your-admin-role'
export PG_ADMIN_PASSWORD='admin-password-from-secret-manager'
export SMOOTH_COACH_DB_PASSWORD='long-unique-application-role-password'

# Optional defaults shown explicitly
export PG_ADMIN_PORT='5432'
export PG_ADMIN_SSLMODE='require'
export SMOOTH_COACH_DATABASE='smooth_coach'
export SMOOTH_COACH_DB_USER='smooth_coach_app'
```

Run:

```bash
chmod +x deploy/postgres/setup-smooth-coach-postgres.sh
./deploy/postgres/setup-smooth-coach-postgres.sh
```

## Scope created by the script

| Resource | Purpose |
|---|---|
| `smooth_coach` database | Isolated application data |
| `smooth_coach_app` role | Application-scoped PostgreSQL access |
| `user_profiles` | Signed-in account profile metadata |
| `user_coach_state` | Daily coaching/check-in state |
| `weight_entries` | Private weight timeline |
| `progress_photos` | Private photo metadata and storage object keys |

The database stores only image metadata and private object keys; photo files remain in the application’s private object storage.
