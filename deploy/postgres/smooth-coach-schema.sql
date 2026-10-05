-- Smooth Coach PostgreSQL schema
-- Target: PostgreSQL 14+ (including RDS PostgreSQL, Cloud SQL PostgreSQL, and Neon)
-- Run this file while connected to the Smooth Coach application database.
-- It is idempotent and does not drop or delete application data.

BEGIN;

-- open_id holds the account ID "<OIDC issuer>|<subject>" (name kept from earlier versions).
-- Databases created by 2.x may also contain an unused progress_photo_uploads table; it is left in place.
CREATE TABLE IF NOT EXISTS user_profiles (
  open_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_coach_state (
  open_id TEXT PRIMARY KEY REFERENCES user_profiles(open_id) ON DELETE CASCADE,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weight_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  open_id TEXT NOT NULL REFERENCES user_profiles(open_id) ON DELETE CASCADE,
  weight NUMERIC(7,2) NOT NULL CHECK (weight > 0),
  unit TEXT NOT NULL CHECK (unit IN ('lb', 'kg')),
  logged_at DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_weight_per_day UNIQUE (open_id, logged_at)
);

CREATE INDEX IF NOT EXISTS weight_entries_user_date
  ON weight_entries (open_id, logged_at);

CREATE TABLE IF NOT EXISTS progress_photos (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  open_id TEXT NOT NULL REFERENCES user_profiles(open_id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  captured_at DATE NOT NULL,
  caption VARCHAR(160) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS progress_photos_user_date
  ON progress_photos (open_id, captured_at);

CREATE OR REPLACE FUNCTION smooth_coach_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profiles_set_updated_at ON user_profiles;
CREATE TRIGGER user_profiles_set_updated_at
BEFORE UPDATE ON user_profiles
FOR EACH ROW EXECUTE FUNCTION smooth_coach_set_updated_at();

DROP TRIGGER IF EXISTS user_coach_state_set_updated_at ON user_coach_state;
CREATE TRIGGER user_coach_state_set_updated_at
BEFORE UPDATE ON user_coach_state
FOR EACH ROW EXECUTE FUNCTION smooth_coach_set_updated_at();

DROP TRIGGER IF EXISTS weight_entries_set_updated_at ON weight_entries;
CREATE TRIGGER weight_entries_set_updated_at
BEFORE UPDATE ON weight_entries
FOR EACH ROW EXECUTE FUNCTION smooth_coach_set_updated_at();

COMMIT;
