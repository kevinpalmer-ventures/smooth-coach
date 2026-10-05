# Claude handoff — Smooth Coach PostgreSQL setup

> **Current architecture:** the server already uses `pg`, reads `DATABASE_URL`, and applies `deploy/postgres/smooth-coach-schema.sql` at every start. This prompt only provisions the database and role and verifies the result; it does not change application code. For the full deployment, follow the self-hosting guide in `README.md`.

Attach the two files in `deploy/postgres/` to Claude Code (or place them in the repository), then paste the prompt below.

---

## Prompt to give Claude

> You are preparing an existing **PostgreSQL 14+** database for the Smooth Coach Docker application. Do not use MySQL, do not change application code, and do not make unrelated infrastructure changes.
>
> ### Database provisioning
> 1. Confirm the target is PostgreSQL 14+ and identify the intended host, port, TLS/CA requirements, and the deployment network. Stop and ask if it is not PostgreSQL or if the target is unclear.
> 2. Use `deploy/postgres/setup-smooth-coach-postgres.sh` and `deploy/postgres/smooth-coach-schema.sql`. Obtain administrator and application passwords from the user’s secret manager or secure terminal input only.
> 3. Set the database name and app role only if the user specifies alternatives; otherwise use `smooth_coach` and `smooth_coach_app`.
> 4. Run the provisioning script once. It may create/alter only the named Smooth Coach role, database, schema objects, and privileges. Do not alter, delete, or inspect unrelated databases, roles, tables, or data.
> 5. Verify exactly four application tables exist, and that the app role can connect using the required TLS settings. Never print passwords, full credential-bearing URLs, or admin credentials.
>
> ### Validation
> 6. Start the app with a PostgreSQL `DATABASE_URL` (see the self-hosting guide in `README.md`); validate `/api/health`, schema initialization, sign-in-required endpoints, a saved coach state, a weight entry, and a photo upload. Do not use production user data for testing.
> 7. Build the Docker image and publish a **new immutable version tag** only after validation. Do not overwrite `latest` without explicit user approval.
>
> ### Secrets and completion
> 8. Store the app connection string in the deployment secret manager in this form, URL-encoding the role/password as needed:
>
>     ```text
>     postgresql://SMOOTH_COACH_DB_USER:URL_ENCODED_PASSWORD@PG_ADMIN_HOST:5432/SMOOTH_COACH_DATABASE?sslmode=verify-full
>     ```
>
>     TLS is controlled entirely by this URL. `sslmode=verify-full` validates the server certificate against the system CAs. If the provider signs with its own CA (for example the RDS bundle), mount that PEM file into the container and add `&sslrootcert=/path/to/ca.pem`. Use `sslmode=no-verify` only if the provider explicitly requires it.
>
> 9. Report only: database host, port, database name, app role, schema verification result, test status, and the new image tag/digest if one is published.

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
