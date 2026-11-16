-- Privileges and constraints of the project tables (ADR-0011, decisions 2 and 7; ADR-0010, decisions 3 and 4).
-- Hand-written: Prisma models neither privileges nor CHECK constraints. It is a separate migration from the generated tables so each can
-- be read on its own, and it runs as the MIGRATION role (the owner of everything below). Purely additive: no existing object is touched.

-- The privilege group the API's login role belongs to. Created here only if provisioning never ran (see the earlier migrations).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app NOLOGIN;
  END IF;
END
$$;

-- Least privilege, with COLUMN-level UPDATE so what must never change cannot be changed by the application role, whatever the code does:
--   project         never deleted in this phase (no DELETE). The only columns the API may change are the ones a project update, archive or
--                   restore touches. NOT updatable: id, organization_id (a project is never moved to another organization), slug
--                   (immutable), created_at.
--   project_member  rows are added, re-roled and removed. Only role (and updated_at) may change: the project, the organization and the user of a
--                   membership are fixed for the life of the row. DELETE is also what the organization-membership cleanup uses.
-- SELECT ... FOR UPDATE / FOR SHARE (the lock protocol of ADR-0011 decision 9) needs UPDATE on at least one column, which these grants give.
GRANT USAGE ON SCHEMA projects TO agentos_app;
GRANT SELECT, INSERT ON TABLE projects.project TO agentos_app;
GRANT UPDATE (name, description, status, archived_at, updated_at) ON TABLE projects.project TO agentos_app;
GRANT SELECT, INSERT, DELETE ON TABLE projects.project_member TO agentos_app;
GRANT UPDATE (role, updated_at) ON TABLE projects.project_member TO agentos_app;

-- Shapes the application validates (projectSlugSchema, projectNameSchema, projectDescriptionSchema) and the database refuses too, so a bug
-- elsewhere cannot store a row the API could never have produced. Lengths count characters; the application counts UTF-16 units, which are
-- never fewer, so everything the application accepts passes. A lower-case-only slug also makes the plain unique index case-safe.
ALTER TABLE projects.project
  ADD CONSTRAINT project_slug_valid
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 2 AND 48);

ALTER TABLE projects.project
  ADD CONSTRAINT project_name_valid
  CHECK (char_length(btrim(name)) >= 1 AND char_length(name) <= 100);

ALTER TABLE projects.project
  ADD CONSTRAINT project_description_valid
  CHECK (description IS NULL OR (char_length(btrim(description)) >= 1 AND char_length(description) <= 2000));

-- Status and archived_at can never disagree.
ALTER TABLE projects.project
  ADD CONSTRAINT project_archive_state
  CHECK ((status = 'archived') = (archived_at IS NOT NULL));
