-- Privileges and constraints of the organization tables (ADR-0010, decisions 3, 4 and 5).
-- Hand-written: Prisma models neither privileges nor CHECK constraints. It is a separate migration from the generated tables so each
-- can be read on its own, and it runs as the MIGRATION role (the owner of everything below).

-- The privilege group the API's login role belongs to. Created here only if provisioning never ran (see the earlier migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app NOLOGIN;
  END IF;
END
$$;

-- Least privilege: exactly what the organizations module does and nothing more.
--   organization  never deleted in this phase (no DELETE); its name changes (UPDATE).
--   membership    rows are added, change role and are removed (a member leaves or is removed), so DELETE is granted. UPDATE is also what
--                 SELECT ... FOR UPDATE needs, which the last-owner protection relies on.
-- USAGE on schema identity was granted by the identity migration.
GRANT SELECT, INSERT, UPDATE ON TABLE identity.organization TO agentos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE identity.membership TO agentos_app;

-- The name is trimmed and bounded by the application (organizationNameSchema). The database refuses an empty or oversized name too, so a
-- bug elsewhere cannot store a row the API could never have produced. (Lengths count characters; the application counts UTF-16 units,
-- which are never fewer, so every name the application accepts passes.)
ALTER TABLE identity.organization
  ADD CONSTRAINT organization_name_valid
  CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 100);
