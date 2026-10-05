# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
