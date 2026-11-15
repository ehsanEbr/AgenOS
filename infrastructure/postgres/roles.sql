-- Database roles of the development stack (ADR-0010, "Database credentials and privileges").
--
-- Run by the `db-roles` Compose service as the PostgreSQL superuser, on EVERY start, against a new or an existing data volume:
-- every statement is idempotent and no data is touched. Passwords come in as psql variables and are re-applied each run, so the
-- roles always match the values in .env.
--
--   postgres superuser   bootstrap and this script only (never used by the API or the migration process)
--   agentos_migrate      owns the schemas and tables, runs `prisma migrate deploy`. Not a superuser.
--   agentos_api          what the API connects as. Not a superuser, owns nothing, can create nothing. It receives its privileges
--                        through the group role agentos_app, and every migration grants that role exactly what its own tables need.
--   agentos_app          privilege group (cannot log in).
--
-- Production deployments provision these roles with their own tooling; this file is the development equivalent.

\set ON_ERROR_STOP on

-- Privilege group. A migration also creates it if it is missing (databases the provisioning never ran for, such as the
-- throwaway databases of the integration tests), so the two stay compatible.
SELECT 'CREATE ROLE agentos_app NOLOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_app') \gexec

SELECT 'CREATE ROLE agentos_migrate LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_migrate') \gexec
-- CREATEDB is needed only by `prisma migrate dev` (its shadow database) on a developer's machine; a production migration role
-- does not get it.
ALTER ROLE agentos_migrate WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'migrate_password';

SELECT 'CREATE ROLE agentos_api LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_api') \gexec
ALTER ROLE agentos_api WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
GRANT agentos_app TO agentos_api;

-- The migration role creates schemas (CREATE on the database) and keeps Prisma's bookkeeping table in `public`.
GRANT CREATE ON DATABASE :"dbname" TO agentos_migrate;
GRANT USAGE, CREATE ON SCHEMA public TO agentos_migrate;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- A volume that was first used before this script existed has Prisma's table owned by the superuser; hand it over so the
-- migration role can record migrations.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    ALTER TABLE public._prisma_migrations OWNER TO agentos_migrate;
  END IF;
END
$$;
