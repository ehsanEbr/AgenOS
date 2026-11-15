-- Privileges for the application role and the append-only guard of the audit trail (ADR-0010, decisions 3 and 6).
-- Hand-written: Prisma does not model privileges or triggers. It is a separate migration from the generated tables so each can be
-- read on its own, and it runs as the MIGRATION role (the owner of everything below).

-- The privilege group the API's login role belongs to. Provisioning (infrastructure/postgres/roles.sql, or the operator in
-- production) normally creates it first; this makes the migration work on a database where that never ran (the throwaway
-- databases of the integration tests). Creating a role needs CREATEROLE: where the migration role lacks it, the role must exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app NOLOGIN;
  END IF;
END
$$;

-- Least privilege: exactly what the Identity module does today and nothing more. In particular: no DELETE anywhere (users and
-- sessions are never deleted in this phase; a session is revoked by setting revoked_at), and no ownership of any object.
GRANT USAGE ON SCHEMA identity TO agentos_app;
GRANT SELECT, INSERT, UPDATE ON TABLE identity."user" TO agentos_app;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.credential TO agentos_app;
GRANT SELECT, INSERT, UPDATE ON TABLE identity.session TO agentos_app;

-- The audit trail is INSERT-only for the application. It has NO SELECT: the writer generates the id itself and uses no RETURNING,
-- so reading is not needed, and a future reader will get its own, separate privilege.
GRANT USAGE ON SCHEMA security TO agentos_app;
GRANT INSERT ON TABLE security.audit_log TO agentos_app;

-- Defense in depth behind those privileges: whoever can still reach the table (its owner, a superuser who has not disabled
-- triggers) is stopped by triggers. Neither is a boundary against a superuser or a schema owner, who can drop them.
CREATE FUNCTION security.audit_log_reject_changes() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% is not allowed)', TG_OP USING ERRCODE = 'restrict_violation';
END
$$;
REVOKE ALL ON FUNCTION security.audit_log_reject_changes() FROM PUBLIC;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON security.audit_log
  FOR EACH ROW EXECUTE FUNCTION security.audit_log_reject_changes();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON security.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION security.audit_log_reject_changes();
