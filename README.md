# Smooth Coach

A calm, day-by-day companion for a 10-day green smoothie routine: today's recipe and routine, a water tracker, reflections, a recipe library, and prep notes. Signed-in users also get a private weight timeline and a private progress-photo timeline.

Smooth Coach organizes user-supplied source material. It is not medical advice.

## Self-hosting

Smooth Coach runs on your own Docker host:

- **app** — the Smooth Coach container, reachable only by your reverse proxy
- **garage** — [Garage](https://garagehq.deuxfleurs.fr/), a small S3-compatible store that keeps photos on your server
- **garage-init** — a one-shot container that sets up Garage's storage, the app's key, and the bucket
- **PostgreSQL** — your existing server (not part of the compose file)
- **Sign-in** — Google, or any OpenID Connect provider

### What you need

- Docker with Compose v2.24 or newer
- A domain, and a reverse proxy that terminates HTTPS for it
- PostgreSQL 14 or newer
- A Google account (or another OpenID Connect provider)
- Node.js on any machine, only to generate secrets with the commands below (or use any other random generator)

### 1. Get the files

```bash
git clone https://github.com/kevinpalmer-ventures/smooth-coach.git
cd smooth-coach
```

The deployment uses `docker-compose.yml`, `deploy/garage/`, and `.env.example`.

### 2. Create the database

On a machine with `psql` that can reach your PostgreSQL server:

```bash
export PG_ADMIN_HOST='your-postgresql-host'
export PG_ADMIN_USERNAME='your-admin-role'
export PG_ADMIN_PASSWORD='admin-password-from-your-secret-manager'
export SMOOTH_COACH_DB_PASSWORD='long-unique-app-password'
./deploy/postgres/setup-smooth-coach-postgres.sh
```

This creates the `smooth_coach` database and the `smooth_coach_app` role, applies the schema, and prints `Tables verified: 4`. The app keeps the schema up to date itself on every start.

If PostgreSQL runs on the Docker host itself, the app reaches it at `host.docker.internal`. PostgreSQL must listen on an address the containers can reach (for example `listen_addresses = '*'`), and `pg_hba.conf` must allow the Docker network (for example `host smooth_coach smooth_coach_app 172.16.0.0/12 scram-sha-256`). If the host runs a firewall such as `ufw`, allow port 5432 from the Docker network too (for example `ufw allow from 172.16.0.0/12 to any port 5432 proto tcp`); a firewall that silently drops the traffic makes the app stop after about 10 seconds with a database connection timeout.

### 3. Create a Google sign-in client

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project.
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and support email, and add the scopes `openid`, `email`, and `profile`.
3. **Publish the app.** While the consent screen is in "Testing", only the test users you list can sign in. These basic scopes do not need Google verification.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
5. Add the authorized redirect URI `https://coach.example.com/api/auth/callback` (your domain).
6. Copy the client ID and client secret.

**Sign-up is open.** Once the consent screen is published, anyone with a Google account can sign in and get their own private account. The only limit on how much they can store is `GARAGE_CAPACITY` (default `10G`). If you want a closed group, keep the app unpublished ("Testing" mode, up to 100 listed test users), put the site behind your reverse proxy's access control, or use an OpenID Connect provider where you control who has an account (see [Other sign-in providers](#other-sign-in-providers)).

### 4. Configure

```bash
cp .env.example smooth-coach.env
```

Fill in every value in `smooth-coach.env`; the file explains each one and how to generate the secrets. `smooth-coach.env` is ignored by git — keep it that way and store the values in a secret manager.

### 5. Start

```bash
docker compose --env-file smooth-coach.env up -d
docker compose --env-file smooth-coach.env logs -f app
```

Wait for `Smooth Coach is ready on port 3000`. If something is wrong, the app stops with a message naming the problem — for example `Smooth Coach requires these environment variables: …` or `Smooth Coach could not start: database: …` — and never prints secret values.

If `up` fails or the app never starts, also check the storage setup log:

```bash
docker compose --env-file smooth-coach.env logs garage-init
```

The app waits for `garage-init` to finish, so a Garage problem shows up there first.

### 6. Point your reverse proxy at it

The app listens on `127.0.0.1:3000`. Photo uploads can be up to 8 MB, so the proxy must accept request bodies of at least 10 MB.

**Caddy** (no body limit by default):

```
coach.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

**nginx** (the default 1 MB limit blocks photo uploads):

```nginx
server {
    listen 443 ssl;
    server_name coach.example.com;
    # ssl_certificate and ssl_certificate_key as usual

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Nginx Proxy Manager, Traefik, or another proxy running in Docker:** a proxy container cannot reach the host's `127.0.0.1`. Put the app on the proxy's Docker network instead with a `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  app:
    ports: !reset []
    networks: [default, proxy]

networks:
  proxy:
    external: true
    name: your-proxy-network
```

Then forward to `smooth-coach-app-1` port `3000`. In Nginx Proxy Manager, also add `client_max_body_size 10m;` under the proxy host's **Advanced** tab.

### 7. First sign-in checklist

1. Open `https://coach.example.com` and click **Sign in**.
2. Google shows your app name; choose an account and continue.
3. You return to Smooth Coach and see "Signed in as …".
4. Add a weight on the **Progress** page, then upload a small photo; both appear in your timeline.
5. Sign out, then sign in with a second Google account: it must not see the first account's weight or photo.

If sign-in shows "The sign-in request could not be verified", check that `APP_URL` exactly matches the address in your browser and that the redirect URI in Google is `APP_URL/api/auth/callback`. The app log names the reason.

### Keeping storage settings stable

- `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are imported into Garage the first time `garage-init` runs. Changing the secret in `smooth-coach.env` later does **not** update the key Garage already stored (`garage-init` keeps an existing key), so the app can no longer sign its photo requests. Keep both values stable. To rotate them, first delete the old key in Garage (for example with the `garage` CLI inside the `garage` container), then run `docker compose --env-file smooth-coach.env up -d` again so `garage-init` imports the new one.
- `GARAGE_CAPACITY` only applies on first setup. Changing it later has no effect on an existing Garage volume.
- The Garage image is pinned (`dxflrs/garage:v2.4.1`). When you upgrade it, re-check `deploy/garage/setup.mjs` against the new version's admin API before deploying, because setup relies on that API.

### Backups

- **Database:** `pg_dump --format=custom --file=smooth-coach.dump "postgresql://…/smooth_coach"`
- **Photos:** stop the app and Garage, archive both Garage volumes, then start again:

```bash
docker compose --env-file smooth-coach.env stop app garage
docker run --rm -v smooth-coach_garage-meta:/meta -v smooth-coach_garage-data:/data -v "$PWD":/backup alpine tar czf /backup/garage-backup.tgz /meta /data
docker compose --env-file smooth-coach.env start garage app
```

Back up the database and the Garage volumes together; each photo row points at an object in Garage.

### Upgrading from 2.x

3.0.0 removes the Manus integration. Accounts are now keyed by your sign-in provider, so 2.x accounts and their data do not carry over — start with a fresh database. Remove every `MANUS_*` variable and set the variables in `.env.example`. Everyone signs in again, because the session cookie changed.

### Other sign-in providers

Any OpenID Connect provider works: set `OIDC_ISSUER` to its issuer URL (for example `https://your-tenant.auth0.com/`, `https://auth.example.com/realms/home` for Keycloak, or `https://auth.example.com/application/o/smooth-coach/` for Authentik), create a confidential client with the redirect URI `APP_URL/api/auth/callback`, and allow the scopes `openid email profile`.

### Other S3 storage

To use Cloudflare R2, AWS S3, or another S3-compatible service instead of Garage, delete the `garage` and `garage-init` services and the app's `depends_on`, then set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` for that service in the app's `environment`. Keep the bucket private; the app never exposes it.

## Development

```bash
npm install
npm run test:stack:up   # throwaway PostgreSQL and Garage in Docker
npm test                # unit and integration tests
npm run test:stack:down
```

`npm run dev` starts the server with Vite's development middleware. It needs the same environment variables as production; for local work you can point `DATABASE_URL` and the `S3_*` variables at the test stack (see `test/helpers/stack.mjs`) and use `APP_URL=http://localhost:3000` with a Google client that allows the redirect URI `http://localhost:3000/api/auth/callback`.
