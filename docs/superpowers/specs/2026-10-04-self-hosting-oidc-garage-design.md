# Smooth Coach 3.0.0 — Self-hosting with OIDC sign-in and Garage photo storage

**Date:** 2026-10-04
**Status:** Approved design, pending implementation plan
**Target version:** 3.0.0 (breaking)

## Summary

Smooth Coach 2.x only runs inside Manus: sign-in (Manus OAuth) and progress-photo storage (Manus storage presign API) depend on platform-injected `MANUS_*` variables. 3.0.0 removes every Manus dependency so the app runs on the owner's Docker host behind their existing reverse proxy:

- Sign-in uses any standard OpenID Connect provider through `openid-client` (Google by default).
- Photos are stored in a self-hosted, S3-compatible **Garage** instance, uploaded and served **through the app server**, never directly from the browser.
- The database stays the owner's existing PostgreSQL server (already supported since 2.0.0).

## Decisions and constraints

| Topic | Decision |
|---|---|
| Hosting | Owner's Docker host via `docker compose`; owner already runs a TLS-terminating reverse proxy |
| Database | Owner's existing PostgreSQL 14+ server, provisioned with `deploy/postgres/setup-smooth-coach-postgres.sh`; not part of the compose file |
| Sign-in | Generic OIDC via `openid-client` v6; Google is the documented default |
| Who can sign in | Anyone with an account at the configured provider (open sign-up) |
| Photo storage | Garage (S3-compatible), single node, in the compose file, reachable only on the internal Docker network |
| Photo transfer | Through the app server (upload and download); bucket is never exposed publicly |
| Existing data | None to migrate; fresh start. No account linking, no import |
| Manus | Removed entirely; no dual code paths |
| Version | 3.0.0 — `MANUS_*` variables removed/replaced and session cookie renamed |

MinIO was the original storage choice, but the MinIO community edition is unmaintained (repository archived February 2026) and its Docker Hub images were deleted on 2026-09-11, so it is not viable. Garage was chosen over SeaweedFS (more concepts than needed) and RustFS (young project).

## Non-goals

- Account linking, data import, or migration from Manus.
- Email allowlists or admin roles.
- Photo deletion, editing, or thumbnails (no such features exist today).
- Single sign-out at the identity provider (logout ends the app session only).
- Multi-node Garage, replication, or bundled backups (backup guidance is documented only).
- Frontend redesign; UI changes are limited to the photo upload call.

## Configuration

`server/config.mjs` reads all variables once at startup. If any required variable is unset or empty, startup fails with one error naming every missing variable (names only, never values) — the 2.0.1 behavior, extended to the new set. Validation errors for malformed values also name the variable without echoing its value.

### Required

| Variable | Purpose and validation |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (unchanged from 2.x). TLS via `sslmode`/`sslrootcert` in the URL |
| `APP_URL` | Public origin, e.g. `https://coach.example.com`. Must parse as a URL with no path beyond `/`; must be `https:` unless the host is a loopback address (`localhost`, `127.0.0.1`, `[::1]`) for local development. Normalized to its origin |
| `SESSION_SECRET` | HMAC key for session and login cookies. Minimum 32 characters |
| `OIDC_ISSUER` | Provider issuer URL, e.g. `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | OAuth client ID from the provider |
| `OIDC_CLIENT_SECRET` | OAuth client secret from the provider |
| `S3_ENDPOINT` | Storage endpoint, e.g. `http://garage:3900` |
| `S3_BUCKET` | Bucket name, e.g. `smooth-coach-photos` |
| `S3_ACCESS_KEY_ID` | App's storage access key |
| `S3_SECRET_ACCESS_KEY` | App's storage secret key |

### Optional

| Variable | Default | Purpose |
|---|---|---|
| `S3_REGION` | `us-east-1` | SigV4 signing region; must match the storage server's configured region (`.env.example` sets `garage`) |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style bucket addressing, required by Garage |
| `PORT` | `3000` | Listen port inside the container |

### Removed

`MANUS_PROJECT_ID`, `MANUS_OAUTH_PORTAL_URL`, `MANUS_OAUTH_API_URL`, `MANUS_JWT_SECRET`, `MANUS_API_URL`, `MANUS_API_KEY`. (`MANUS_JWT_SECRET`'s role is taken by `SESSION_SECRET`.)

### Compose-only variables (not read by the app)

| Variable | Used by |
|---|---|
| `GARAGE_RPC_SECRET` | `garage` (64 hex characters) |
| `GARAGE_ADMIN_TOKEN` | `garage` and `garage-init` |
| `GARAGE_CAPACITY` (optional, default `10G`) | `garage-init` (node capacity in the cluster layout) |

`garage-init` also receives `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` to create the bucket and the app's key.

## Architecture

`server/index.mjs` (currently 414 lines doing everything) is split into focused ES modules:

| Module | Responsibility | Depends on |
|---|---|---|
| `server/config.mjs` | Read and validate environment; export a frozen config object | — |
| `server/db.mjs` | `pg` pool, pool error logging, `ensureSchema()` (moved unchanged from 2.x) | config |
| `server/auth.mjs` | OIDC discovery, login/callback/logout/me routes, session cookie, `requireUser` middleware, profile upsert | config, db |
| `server/photoStorage.mjs` | S3 client; `checkBucket()`, `putPhoto(key, body, contentType)`, `getPhotoStream(key)`, `deletePhoto(key)`; `sniffImageType(buffer)` | config |
| `server/index.mjs` | Startup sequence, Express wiring, coach-state, weight, and photo routes, static/dev serving, error handler | all of the above |

**Startup sequence:** load config → `ensureSchema()` → OIDC discovery → `checkBucket()` (S3 `HeadBucket`) → listen. Any failure exits non-zero with a message naming the failing component (database, sign-in provider, or photo storage) and never printing secrets; Docker's restart policy retries.

**New dependencies:** `openid-client` (v6, ESM), `@aws-sdk/client-s3`, `multer` (v2). No dependencies are removed; the Manus integration used only the built-in `fetch`.

## Sign-in (OIDC)

### Discovery

`openid-client`'s `discovery()` loads provider metadata from `OIDC_ISSUER` with the client ID and secret (the library's default client authentication). `enableNonRepudiationChecks` is always applied, so ID token signatures are verified against the provider's JWKS. Without it, `openid-client` accepts unverified signatures on ID tokens received directly from the token endpoint (OIDC permits relying on TLS there); a prototype confirmed a token signed by an unknown key was accepted until this was enabled. `allowInsecureRequests` is applied **only** when the issuer URL is `http:` on a loopback host, which enables the local fake provider in tests and local development; any other `http:` issuer is rejected at startup.

### Routes

- **`GET /api/auth/login`** — generates a PKCE code verifier, `state`, and `nonce` with `openid-client` helpers. Stores them in the **login cookie** `smooth_coach_login`: an HS256 JWT signed with `SESSION_SECRET`, 10-minute expiry, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/api/auth`. Redirects to the provider's authorization URL with `response_type=code`, `scope=openid email profile`, `redirect_uri=APP_URL/api/auth/callback`, `code_challenge_method=S256`, the challenge, `state`, and `nonce`.
- **`GET /api/auth/callback`** — reads and verifies the login cookie, clears it, then calls `authorizationCodeGrant()` with the current URL built from `APP_URL` + the request path and query (never from request `Host` headers), the PKCE verifier, `expectedState`, and `expectedNonce`. The library validates the ID token signature, `iss`, `aud`, `exp`, and nonce. On any failure (missing/expired/forged login cookie, state mismatch, provider error, token validation failure) it responds `400` with the existing message "The sign-in request could not be verified. Return to Smooth Coach and try again." and logs the reason without tokens. On success it upserts the profile, sets the session cookie, and redirects to `/`.
- **`POST /api/auth/logout`** — clears the session cookie; `204`.
- **`GET /api/auth/me`** — `200 { user }` with a valid session (and upserts the profile, as today), else `401` (unchanged contract).
- **`requireUser`** — verifies the session cookie only and performs no database write (2.x upserted the profile on every protected request; the profile is now written at sign-in and by `/me`, which the app calls on every load).

### Account identity and profile

- Account ID = `${issuer}|${sub}`, using the discovered metadata's `issuer` and the ID token's `sub`. Stored in the existing `open_id` column (name kept to avoid schema churn; the schema file gets a comment documenting its meaning).
- Display name = `name` claim, else `email`, else "Smooth Coach member". Email = `email` claim or empty string.
- Email is display-only and never used to identify or authorize, so `email_verified` is not required.

### Session cookie

`smooth_coach_session` (renamed from `webdev_app_session`): HS256 JWT signed with `SESSION_SECRET`, claims `sub` (account ID), `name`, `email`, `iss: "smooth-coach"`, `aud: "smooth-coach"`, 30-day expiry. Verified with `algorithms: ["HS256"]` and fixed issuer/audience. Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. (`SameSite=None` existed only for Manus's embedded preview and is dropped.) Rotating `SESSION_SECRET` signs everyone out.

### Frontend

No changes to sign-in: `src/App.tsx` already only uses `/api/auth/login`, `/api/auth/me`, and `/api/auth/logout`.

## Progress photos

### Upload — `POST /api/progress-photos`

`multipart/form-data` with fields `photo` (file), `capturedAt` (`YYYY-MM-DD`), `caption` (optional). Requires a session.

1. `multer` with memory storage and limits: 1 file, `fileSize` 8 MiB, 2 non-file fields, `fieldSize` 1 KiB. Exceeding the file size → `413` "Choose a dated JPEG, PNG, or WebP image up to 8 MB."; any other multer error → `400`.
2. `sniffImageType()` checks the leading bytes — JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP `RIFF` at offset 0 and `WEBP` at offset 8 — and returns `image/jpeg`, `image/png`, `image/webp`, or null. The browser-declared type is ignored. Null or an empty file → `400`.
3. Validates `capturedAt` with the existing `isRealDate()`. Trims surrounding whitespace from `caption`; if the trimmed caption is longer than 160 characters → `400` (never silently truncated), as today.
4. Key: `progress-photos/<first 32 hex chars of sha256(account ID)>/<capturedAt>/<random UUID>.<jpg|png|webp>`.
5. `putPhoto()` (S3 `PutObject` with sniffed `ContentType`), then `INSERT INTO progress_photos`. If the insert fails, `deletePhoto()` is attempted (failure only logged) and the error propagates to the generic `500`.
6. Responds `201 { photos }` — the account's full photo list, same shape as today.

### List — `GET /api/progress-photos`

Returns `{ photos: [{ id, capturedAt, caption, imageUrl }] }` ordered by `captured_at, id`, where `imageUrl` is `/api/progress-photos/<id>/image`. No storage calls (2.x made one presign call per photo).

### Image — `GET /api/progress-photos/:id/image`

Requires a session. `:id` must be a positive integer, else `404`. Selects `storage_key` by `id` **and** `open_id`; no row → `404` (does not reveal whether another account's photo exists). Streams `getPhotoStream()` to the response with `Content-Type` derived from the key's extension, `Cache-Control: private, max-age=3600`, and `X-Content-Type-Options: nosniff`. Missing object (`NoSuchKey`) → `404`. Storage errors before headers are sent → generic `500`; errors mid-stream destroy the response.

### Removed

`POST /api/progress-photos/presign` and all Manus presign/verify code.

### Errors

Storage unreachable or misconfigured → generic `500` "Smooth Coach could not complete that request. Please try again." plus a server log line identifying photo storage as the failing component (no credentials or keys logged).

### Frontend

`handlePhotoUpload` in `src/App.tsx` becomes a single `fetch("/api/progress-photos", { method: "POST", body: formData })` with fields `photo`, `capturedAt`, `caption`; error handling unchanged (shows the server's `error` message). `src/ProgressPhotos.tsx` is unchanged; same-origin `<img>` requests carry the session cookie.

## Schema

- `deploy/postgres/smooth-coach-schema.sql` drops the `CREATE TABLE`/`CREATE INDEX` for `progress_photo_uploads` (no `DROP` statements are added; an existing table is left unused). A comment documents that `open_id` holds the `issuer|sub` account ID.
- `setup-smooth-coach-postgres.sh` verifies 4 tables: `user_profiles`, `user_coach_state`, `weight_entries`, `progress_photos`.
- No column changes; photo content type is derived from the storage key extension.

## Packaging

### `docker-compose.yml`

Run with `docker compose --env-file smooth-coach.env up -d`. Each service receives only the variables it needs through `environment:` interpolation (no shared `env_file`), so the app never sees Garage's admin token or RPC secret.

| Service | Details |
|---|---|
| `app` | `venturesconsulting/smooth-coach:3.0.0`; app variables only; ports `127.0.0.1:3000:3000` (reverse proxy only); `extra_hosts: host.docker.internal:host-gateway` so a PostgreSQL server on the host is reachable; `depends_on: garage-init` with `condition: service_completed_successfully`; `restart: unless-stopped` |
| `garage` | `dxflrs/garage` pinned to the newest stable `v2.x` tag at implementation time (never `latest`); config `deploy/garage/garage.toml` mounted read-only; named volumes `garage-meta` and `garage-data`; `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` from env; no published ports; `restart: unless-stopped` |
| `garage-init` | `node:22-alpine` running `deploy/garage/init.mjs` (mounted read-only); idempotent one-shot that exits `0` when done |

### `deploy/garage/garage.toml`

Single node: `replication_factor = 1`, `db_engine = "lmdb"`, metadata and data directories on the two volumes, RPC bound internally, `[s3_api]` with `s3_region = "garage"` and `api_bind_addr = "[::]:3900"`, `[admin]` with `api_bind_addr = "[::]:3903"`. Secrets come from the environment, not the file.

### `deploy/garage/init.mjs`

Uses Garage admin API v2 (`http://garage:3903`, bearer `GARAGE_ADMIN_TOKEN`), with endpoint shapes verified against the pinned version's OpenAPI document:

1. Wait until the admin API responds (bounded retries).
2. If the cluster layout has no role for the node: assign the node (zone `dc1`, capacity from optional `GARAGE_CAPACITY`, default `10G`) and apply layout version 1.
3. Import the app key from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` if it does not exist.
4. Create bucket `S3_BUCKET` if it does not exist.
5. Grant the key read and write (not owner) on the bucket.

Every step checks current state first, so re-running is safe. It logs each action without printing secrets and exits non-zero on failure.

`.env.example` documents generating Garage-compatible credentials: access key ID `GK` + 24 hex characters, secret 64 hex characters, RPC secret 64 hex characters, admin token random.

### Image

The Dockerfile is unchanged apart from what the build already copies (`dist`, `server`, schema file). Garage files are mounted by compose, not baked into the app image.

## Documentation

- **`README.md` (new)** — what Smooth Coach is; self-hosting guide: (1) provision the database on the existing PostgreSQL server; (2) create a Google OAuth "Web application" client with redirect URI `https://<domain>/api/auth/callback`, consent screen External and published (in "Testing" only listed test users can sign in; basic scopes need no Google verification); (3) fill `smooth-coach.env` from `.env.example`; (4) `docker compose --env-file smooth-coach.env up -d`; (5) reverse proxy snippets for Caddy, nginx, and Nginx Proxy Manager, with nginx/NPM `client_max_body_size 10m` (their 1 MB default blocks photo uploads); (6) backups: PostgreSQL dump plus the `garage-meta` and `garage-data` volumes; (7) upgrading from 2.x; (8) first sign-in verification checklist.
- **`.env.example`** — rewritten for the 3.0.0 variables, with Garage compose-only variables in their own section.
- **`plan.md`** and **`deploy/CLAUDE_DATABASE_SETUP.md`** — remove Manus references and describe the new architecture.

## Manus cleanup

Delete `app.config.ts` (unreferenced Manus logo URL) and `public/manus-routes.json` (unreferenced). Remove the Manus sandbox hostname from `allowedHosts` in `vite.config.ts`.

## Testing

`npm test` runs `node --test` (no framework dependency). Integration tests require `test/compose.yml` (throwaway PostgreSQL 16 and Garage on fixed localhost ports) to be running; the README documents `docker compose -f test/compose.yml up -d`. Tests start the real server as a child process with test configuration.

**Fake OIDC provider (test helper):** in-process HTTP server on a loopback port serving `/.well-known/openid-configuration`, a JWKS with a generated RS256 key, `/authorize` (immediately redirects back with a code, echoing `state`), and `/token` (returns an ID token with configurable claims). Test hooks can swap the signing key, audience, nonce, or issuer to simulate attacks.

| Area | Cases |
|---|---|
| Config (unit) | All missing → names all required variables; partial → names only missing; empty counts as missing; values never printed; invalid `APP_URL` (non-https public host, path) and short `SESSION_SECRET` rejected |
| Image sniffing (unit) | JPEG, PNG, WebP recognized; GIF, text, truncated headers, and empty buffer rejected |
| Sign-in (integration) | Full happy path sets session and `/me` works; tampered `state` rejected; missing, expired, and forged login cookie rejected; wrong nonce rejected; ID token signed by an unknown key rejected; wrong audience rejected; logout clears session; forged session cookie → 401 |
| Coach state and weights (integration) | Port of the 2.0 migration checks: unauthenticated 401s, JSONB round-trip, upsert, validation, unit lock, date validation, ordering, per-account isolation |
| Photos (integration) | Valid JPEG/PNG/WebP upload → 201 and listed; disguised file (`.png` name, non-image bytes) → 400; oversize → 413; bad date and long caption → 400; image route streams correct bytes and headers; another account's image → 404; non-numeric id → 404; storage unavailable → 500 with storage log line |
| Startup (integration) | Unreachable OIDC issuer and missing bucket each exit non-zero naming the component |

**Manual (owner):** one real Google sign-in on the owner's domain using the README checklist, since it needs the owner's Google client credentials.

## Release

- `CHANGELOG.md`: `[Unreleased]` entries (including the existing `.env.example` and `*.env` ignore entries) move into `## [3.0.0] - <release date>`, with a **BREAKING** note listing removed and renamed variables and the cookie rename.
- Version 3.0.0 in `package.json` and `package-lock.json`; `chore(release): v3.0.0`; tag `v3.0.0`; push.
- Build `venturesconsulting/smooth-coach:3.0.0` from a clean export of the tag; smoke-test it with the compose stack and the fake OIDC provider before pushing. `latest` moves only with the owner's explicit approval.

## Risks

| Risk | Mitigation |
|---|---|
| Garage admin API changes between versions | Pin the Garage image tag; `init.mjs` targets admin API v2 for that version; README notes to re-check on Garage upgrades |
| Proxy body-size limit blocks uploads | README snippets set 10 MB; upload errors surface the server/proxy status in the UI |
| Photos lost with Docker volumes | README backup section covers both Garage volumes alongside the database dump |
| Google app left in "Testing" | README checklist calls out publishing the consent screen |
