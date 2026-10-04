#!/usr/bin/env bash
# Idempotently provisions the Smooth Coach PostgreSQL database, application role,
# and schema. Designed for PostgreSQL 14+.
#
# Required environment variables:
#   PG_ADMIN_HOST               Database host or private endpoint
#   PG_ADMIN_USERNAME           Administrator with CREATEDB and CREATEROLE privileges
#   PG_ADMIN_PASSWORD           Administrator password (use a secret manager; do not commit it)
#   SMOOTH_COACH_DB_PASSWORD    New/existing application-role password (use a secret manager)
#
# Optional environment variables:
#   PG_ADMIN_PORT=5432
#   PG_ADMIN_SSLMODE=require    See libpq sslmode values
#   SMOOTH_COACH_DATABASE=smooth_coach
#   SMOOTH_COACH_DB_USER=smooth_coach_app
#
# Example:
#   export PG_ADMIN_HOST='postgres.internal.example'
#   export PG_ADMIN_USERNAME='db_admin'
#   export PG_ADMIN_PASSWORD='...'
#   export SMOOTH_COACH_DB_PASSWORD='...'
#   ./deploy/postgres/setup-smooth-coach-postgres.sh

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
schema_file="$script_dir/smooth-coach-schema.sql"
psql_bin="${PSQL_BIN:-psql}"

require_value() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$key" >&2
    exit 2
  fi
}

validate_identifier() {
  local label="$1" value="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]]; then
    printf '%s must start with a letter/underscore and contain only letters, numbers, and underscores (up to 63 characters).\n' "$label" >&2
    exit 2
  fi
}

sql_literal() {
  # Emits one value safely escaped for a PostgreSQL single-quoted string literal.
  printf '%s' "$1" | sed "s/'/''/g"
}

require_value PG_ADMIN_HOST
require_value PG_ADMIN_USERNAME
require_value PG_ADMIN_PASSWORD
require_value SMOOTH_COACH_DB_PASSWORD

if ! command -v "$psql_bin" >/dev/null 2>&1; then
  printf 'PostgreSQL client not found. Install postgresql-client or set PSQL_BIN.\n' >&2
  exit 127
fi
if [[ ! -f "$schema_file" ]]; then
  printf 'Schema file not found: %s\n' "$schema_file" >&2
  exit 1
fi

admin_port="${PG_ADMIN_PORT:-5432}"
sslmode="${PG_ADMIN_SSLMODE:-require}"
database="${SMOOTH_COACH_DATABASE:-smooth_coach}"
app_user="${SMOOTH_COACH_DB_USER:-smooth_coach_app}"

validate_identifier SMOOTH_COACH_DATABASE "$database"
validate_identifier SMOOTH_COACH_DB_USER "$app_user"
if [[ ! "$admin_port" =~ ^[0-9]{1,5}$ ]] || (( admin_port < 1 || admin_port > 65535 )); then
  printf 'PG_ADMIN_PORT must be between 1 and 65535.\n' >&2
  exit 2
fi
case "$sslmode" in
  disable|allow|prefer|require|verify-ca|verify-full) ;;
  *) printf 'PG_ADMIN_SSLMODE must be a valid libpq sslmode.\n' >&2; exit 2 ;;
esac

admin_args=(
  --host="$PG_ADMIN_HOST"
  --port="$admin_port"
  --username="$PG_ADMIN_USERNAME"
  --dbname=postgres
  --set=ON_ERROR_STOP=1
  --no-psqlrc
  --quiet
)
app_args=(
  --host="$PG_ADMIN_HOST"
  --port="$admin_port"
  --username="$app_user"
  --dbname="$database"
  --set=ON_ERROR_STOP=1
  --no-psqlrc
  --quiet
)

run_admin() {
  PGPASSWORD="$PG_ADMIN_PASSWORD" PGSSLMODE="$sslmode" "$psql_bin" "${admin_args[@]}" "$@"
}

run_app() {
  PGPASSWORD="$SMOOTH_COACH_DB_PASSWORD" PGSSLMODE="$sslmode" "$psql_bin" "${app_args[@]}" "$@"
}

app_user_sql="$(sql_literal "$app_user")"
app_password_sql="$(sql_literal "$SMOOTH_COACH_DB_PASSWORD")"
database_sql="$(sql_literal "$database")"

# Create or rotate only the named Smooth Coach application role. The password is
# sent to psql over stdin; it is not included in command-line arguments.
run_admin <<SQL
DO \$smooth_coach\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$app_user_sql') THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', '$app_user_sql', '$app_password_sql');
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '$app_user_sql', '$app_password_sql');
  END IF;
END
\$smooth_coach\$;
SQL

# CREATE DATABASE cannot run inside a transaction, so psql executes the generated
# statement with \gexec only when this database does not already exist.
run_admin <<SQL
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', '$database_sql', '$app_user_sql')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$database_sql')
\gexec
SQL

# Give the app role only access to its database and the public schema. It owns the
# tables created by the schema script and therefore needs no global privileges.
run_admin --dbname="$database" <<SQL
GRANT CONNECT, TEMPORARY ON DATABASE \"$database\" TO \"$app_user\";
GRANT USAGE, CREATE ON SCHEMA public TO \"$app_user\";
SQL

# Applying the schema as the application role confirms its runtime privileges.
run_app --file="$schema_file"

expected_tables=5
actual_table_count="$(run_app --tuples-only --no-align --command "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('user_profiles', 'user_coach_state', 'weight_entries', 'progress_photos', 'progress_photo_uploads');")"
if [[ "$actual_table_count" != "$expected_tables" ]]; then
  printf 'Schema verification failed: expected %s tables, found %s.\n' "$expected_tables" "$actual_table_count" >&2
  exit 1
fi

printf 'Smooth Coach PostgreSQL setup complete.\n'
printf 'Database: %s\nApplication role: %s\nTables verified: %s\n' \
  "$database" "$app_user" "$actual_table_count"
printf 'Store DATABASE_URL in your deployment secret manager; do not print or commit its password.\n'
