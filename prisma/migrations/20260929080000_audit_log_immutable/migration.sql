-- Immutable audit trail at the database level:
-- UPDATE and DELETE on "TaskAuditLog" raise an exception, even for raw SQL
-- from the app role. Rows can only be INSERTed.

CREATE OR REPLACE FUNCTION audit_log_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TaskAuditLog is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_audit_log_no_update ON "TaskAuditLog";
CREATE TRIGGER task_audit_log_no_update
  BEFORE UPDATE ON "TaskAuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

DROP TRIGGER IF EXISTS task_audit_log_no_delete ON "TaskAuditLog";
CREATE TRIGGER task_audit_log_no_delete
  BEFORE DELETE ON "TaskAuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
