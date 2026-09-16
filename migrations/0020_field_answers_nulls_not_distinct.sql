DROP INDEX IF EXISTS field_answers_scope_idx;
CREATE UNIQUE INDEX field_answers_scope_idx ON field_answers (user_id, host, field_signature) NULLS NOT DISTINCT;
