# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.0.1] - 2026-10-05

### Fixed
- Startup no longer exits when the database is briefly unreachable. Transient connection errors (unreachable, refused, timed out, reset, DNS not ready, "database starting up") are retried every second for up to `DATABASE_STARTUP_TIMEOUT` seconds (optional, default 30), with a log line for each wait. This fixes a crash loop on macvlan networks, where the link needs a few seconds after the container starts. Wrong credentials, a missing database or an unknown host still fail immediately.
- `docker-compose.yml` passes `DATABASE_STARTUP_TIMEOUT` to the app and pins image 3.0.1.

## [3.0.0] - 2026-10-05

### Added
- Self-hosting with Docker Compose: the app plus a bundled Garage S3-compatible store and a one-shot, idempotent `garage-init` setup container. PostgreSQL stays your existing server.
- Sign-in with Google or any OpenID Connect provider (PKCE, state, nonce, and verified ID-token signatures via `openid-client`).
- `README.md` self-hosting guide: database provisioning, Google client setup (including that sign-up is open to anyone at the provider), reverse proxy snippets (including the 10 MB upload limit nginx needs), backups, and a first sign-in checklist.
- `.env.example` documenting every setting, where each value comes from, and how to generate secrets.
- Automated tests (`npm test`) with a throwaway PostgreSQL and Garage stack, a fake OpenID Connect provider for sign-in attack cases, and a container smoke test.

### Changed
- **BREAKING:** Configuration uses `APP_URL`, `SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (plus optional `S3_REGION`, `S3_FORCE_PATH_STYLE`, `PORT`) instead of `MANUS_*`. Startup names any missing or invalid setting without printing values, and names the failing component (database, sign-in provider, or photo storage) with a readable reason — including a hint when `DATABASE_URL` points at `localhost` inside the container.
- **BREAKING:** The session cookie is now `smooth_coach_session` with `SameSite=Lax`; everyone signs in again after upgrading. Accounts are keyed by the sign-in provider (`issuer|subject`), so 2.x accounts do not carry over.
- Progress photos are uploaded to and served by the app server; listing photos no longer calls the storage service, and abandoned downloads release their storage connection.
- Protected API requests no longer write the user profile on every call; it is written at sign-in and when the app loads.
- Database connections time out after 10 seconds instead of waiting for the operating system's TCP timeout.

### Removed
- The Manus integration: Manus OAuth, the Manus storage presign API, `app.config.ts`, and `public/manus-routes.json`.
- `POST /api/progress-photos/presign` and the `progress_photo_uploads` table from the schema (existing tables are left untouched).

### Security
- Photo files are checked by their actual bytes (JPEG, PNG, or WebP) instead of the browser-declared type, and every image request requires the owner's session; the bucket is never publicly reachable.
- ID-token signatures are verified against the provider's published keys, in addition to TLS.
- `*.env` files (such as `smooth-coach.env`) are ignored by git and excluded from Docker build contexts.

## [2.0.1] - 2026-10-04

### Fixed
- The startup error for missing configuration now names which required environment variables are unset or empty (names only, never values).

## [2.0.0] - 2026-10-04

### Changed
- **BREAKING:** The server now uses PostgreSQL 14+ through the `pg` driver instead of MySQL. `DATABASE_URL` must be a `postgresql://` connection string; MySQL databases are no longer supported.
- At startup the server applies `deploy/postgres/smooth-coach-schema.sql` (idempotent, additive) under an advisory lock instead of inline MySQL DDL. The Docker image now includes that file.

### Fixed
- `setup-smooth-coach-postgres.sh` failed at the privilege-grant step because escaped quotes inside the heredoc reached `psql` as `\"` meta-commands.
- Shell scripts are now checked out with LF line endings (`.gitattributes`), so the provisioning script runs from a Windows checkout.

### Removed
- The `mysql2` dependency.

### Security
- Database TLS certificates are now validated. TLS is configured through `DATABASE_URL` (`sslmode=verify-full`, optionally `sslrootcert=`) instead of the previous hardcoded `rejectUnauthorized: false`.

## [1.1.0]

### Added
- Private progression photos, private accounts with weight tracking, and the 10-day Smooth Coach daily guidance app.
