SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The Cortex machines restated as the emitter spells them now: a seed
-- restores its row in the state it names, entering nothing (900_seed.sql marks
-- its session as seeding). 20261105_cortex_generation and
-- 20261113_trigger_origin_reducers keep the bytes a database ran.

ALTER TABLE "deck_progress" DROP CONSTRAINT IF EXISTS "deck_progress_status_check";
ALTER TABLE "deck_progress" ADD CONSTRAINT "deck_progress_status_check" CHECK ("status" IN ('drafting', 'drawing2', 'drawing23', 'drawn2_complete', 'drawn2_partial', 'drawn2_failed', 'drawing3_complete', 'drawing3_partial', 'drawing3_failed', 'done', 'partial', 'failed')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_deck_progress_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  cortex_event text;
  cortex_payload jsonb;
  cortex_rows integer;
  cortex_changed integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND relation = TG_RELID AND depth = pg_trigger_depth() AND machine = 'deck_progress' AND row_key = OLD."id"::text
      RETURNING event, payload INTO cortex_event, cortex_payload;
    IF FOUND THEN
    IF OLD."status" = 'drafting' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawing2';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NOT NULL)) IS TRUE THEN
NEW."status" := 'drawing23';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing2' THEN
NEW."status" := 'drawing2';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing23' THEN
NEW."status" := 'drawing23';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawing2' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NOT NULL)) IS TRUE THEN
NEW."status" := 'drawing23';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing23' THEN
NEW."status" := 'drawing23';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawing23' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'running' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawing2';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing2' THEN
NEW."status" := 'drawing2';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawn2_complete' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawn2_partial' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawn2_failed' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawing3_complete' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawing3_partial' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawing3_failed' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' IS NULL)) IS TRUE THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'done' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'partial' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'partial' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete')) IS TRUE THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed')) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'done' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'failed' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'failed' THEN
IF cortex_event = 'drafting' THEN
NEW."status" := 'drafting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.progress' THEN

IF (NEW.run IS DISTINCT FROM cortex_payload->>'run') IS TRUE THEN
NEW."status" := 'drafting';
        NEW."run" := cortex_payload->>'run';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."run" IS NOT DISTINCT FROM OLD."run" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'running')) IS TRUE THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (NEW.run = cortex_payload->>'run' AND (cortex_payload->>'level2' IN ('complete', 'partial', 'failed') AND cortex_payload->>'level3' IN ('complete', 'partial', 'failed') AND NOT (cortex_payload->>'level2' = 'complete' AND cortex_payload->>'level3' = 'complete') AND NOT (cortex_payload->>'level2' = 'failed' AND cortex_payload->>'level3' = 'failed'))) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
IF cortex_event = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'partial' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
      RETURN NULL;
    END IF;
  END IF;  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'drafting' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'deck_progress', 'drafting', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'drafting' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing2' THEN
NEW."status" := 'drawing2';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing23' THEN
NEW."status" := 'drawing23';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawing2' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing23' THEN
NEW."status" := 'drawing23';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawing23' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing2' THEN
NEW."status" := 'drawing2';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawn2_complete' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawn2_partial' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawn2_failed' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawing3_complete' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_complete' THEN
NEW."status" := 'drawn2_complete';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawing3_partial' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_partial' THEN
NEW."status" := 'drawn2_partial';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawing3_failed' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;
IF NEW."status" = 'drawn2_failed' THEN
NEW."status" := 'drawn2_failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'done' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'partial' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_complete' THEN
NEW."status" := 'drawing3_complete';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_partial' THEN
NEW."status" := 'drawing3_partial';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'failed' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
RETURN NEW;
END IF;
IF NEW."status" = 'drawing3_failed' THEN
NEW."status" := 'drawing3_failed';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_progress', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_deck_progress_status_machine" ON "deck_progress";
CREATE TRIGGER "trg_deck_progress_status_machine"
  BEFORE INSERT OR UPDATE ON "deck_progress"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_deck_progress_status_machine"();

ALTER TABLE "generation_draft" DROP CONSTRAINT IF EXISTS "generation_draft_status_check";
ALTER TABLE "generation_draft" ADD CONSTRAINT "generation_draft_status_check" CHECK ("status" IN ('drafting', 'illustrating', 'idle', 'done', 'failed')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_generation_draft_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD' AS $$
DECLARE
  outcome jsonb;
  cortex_event text;
  cortex_payload jsonb;
  cortex_rows integer;
  cortex_changed integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('drafting', 'illustrating') THEN
      RAISE EXCEPTION '% in % awaits an outcome and is not deleted', 'generation_draft', OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'drafting' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."region" IS DISTINCT FROM NEW."region" OR OLD."topic" IS DISTINCT FROM NEW."topic") THEN
    RAISE EXCEPTION '% in drafting keeps its key until the outcome of %', 'generation_draft', 'smollm3-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'illustrating' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."locale" IS DISTINCT FROM NEW."locale" OR OLD."region" IS DISTINCT FROM NEW."region" OR OLD."topic" IS DISTINCT FROM NEW."topic") THEN
    RAISE EXCEPTION '% in illustrating keeps its key until the outcome of %', 'generation_draft', 'heavy-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND relation = TG_RELID AND depth = pg_trigger_depth() AND machine = 'generation' AND row_key = OLD."id"::text
      RETURNING event, payload INTO cortex_event, cortex_payload;
    IF FOUND THEN
    IF OLD."status" = 'drafting' THEN
RETURN NULL;
    END IF;
    IF OLD."status" = 'illustrating' THEN
RETURN NULL;
    END IF;
    IF OLD."status" = 'idle' THEN
IF cortex_event = 'facts.text' THEN

IF (cortex_payload->>'tier' = 'cheap' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'drafting';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (cortex_payload->>'tier' = 'heavy' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'illustrating';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
IF cortex_event = 'start_draft' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'start_illustrate' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'finish_fast' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'fail' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'done' THEN
IF cortex_event = 'facts.text' THEN

IF (cortex_payload->>'tier' = 'cheap' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'drafting';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (cortex_payload->>'tier' = 'heavy' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'illustrating';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
IF cortex_event = 'start_draft' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'start_illustrate' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'fail' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'reset' THEN
NEW."status" := 'idle';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'failed' THEN
IF cortex_event = 'facts.text' THEN

IF (cortex_payload->>'tier' = 'cheap' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'drafting';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE (candidate->>'cover' = '🎨' AND (candidate->>'cards')::integer > 0 AND candidate->>'cards' = candidate->>'expected') AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (cortex_payload->>'tier' = 'heavy' AND (SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1) IS NOT NULL) IS TRUE THEN
NEW."status" := 'illustrating';
        NEW."topic" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'name';
        NEW."details" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'details';
        NEW."locale" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'locale';
        NEW."region" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'region';
        NEW."card_count" := (((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'cards')::integer;
        NEW."set_id" := ((SELECT candidate FROM jsonb_array_elements(cortex_payload->'candidates') WITH ORDINALITY AS c(candidate, ordinal)
 WHERE ((candidate->>'cards')::integer > 0) AND candidate->>'run' IS NOT NULL AND NOT (candidate->>'has_art')::boolean
   AND (OLD.set_id, OLD.region) IS DISTINCT FROM (candidate->>'id', candidate->>'region')
   AND NOT (OLD.status = 'done' AND OLD.topic LIKE '% :: [TRANSLATE:%')
 ORDER BY ordinal LIMIT 1))->>'id';
        NEW."category" := '';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND NEW."topic" IS NOT DISTINCT FROM OLD."topic" AND NEW."details" IS NOT DISTINCT FROM OLD."details" AND NEW."locale" IS NOT DISTINCT FROM OLD."locale" AND NEW."region" IS NOT DISTINCT FROM OLD."region" AND NEW."card_count" IS NOT DISTINCT FROM OLD."card_count" AND NEW."set_id" IS NOT DISTINCT FROM OLD."set_id" AND NEW."category" IS NOT DISTINCT FROM OLD."category" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
IF cortex_event = 'start_draft' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'start_illustrate' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'reset' THEN
NEW."status" := 'idle';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'complete' THEN
NEW."status" := 'done';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
      RETURN NULL;
    END IF;
  END IF;  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'idle' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'generation_draft', 'idle', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'drafting' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'smollm3-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves drafting only by the recorded outcome of %', 'generation_draft', 'smollm3-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text USING ERRCODE = 'check_violation';
      END IF;
IF NEW."status" = 'done' AND outcome->>'kind' = 'done' THEN
NEW."status" := 'done';
        NEW."category" := COALESCE(outcome->'data'->>'cards_json', NEW.category);
        PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 2, outcome);
        PERFORM snapcards_advance_decks();
RETURN NEW;
END IF;
IF NEW."status" = 'failed' AND outcome->>'kind' <> 'done' THEN
NEW."status" := 'failed';
        NEW."category" := COALESCE(outcome->>'data', outcome->>'kind');
        PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 2, outcome);
        PERFORM snapcards_advance_decks();
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'generation_draft', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'illustrating' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'heavy-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves illustrating only by the recorded outcome of %', 'generation_draft', 'heavy-draft:' || jsonb_build_array(OLD."id"::text, OLD."topic"::text, OLD."locale"::text, OLD."region"::text)::text USING ERRCODE = 'check_violation';
      END IF;
IF NEW."status" = 'done' AND outcome->>'kind' = 'done' THEN
NEW."status" := 'done';
        NEW."category" := COALESCE(outcome->'data'->>'cards_json', NEW.category);
        PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 3, outcome);
        PERFORM snapcards_advance_decks();
RETURN NEW;
END IF;
IF NEW."status" = 'failed' AND outcome->>'kind' <> 'done' THEN
NEW."status" := 'failed';
        NEW."category" := COALESCE(outcome->>'data', outcome->>'kind');
        PERFORM snapcards_fan_out_art(NEW.set_id, NEW.region, 3, outcome);
        PERFORM snapcards_advance_decks();
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'generation_draft', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'idle' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'illustrating' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'generation_draft', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'done' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'illustrating' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;
IF NEW."status" = 'idle' THEN
NEW."status" := 'idle';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'generation_draft', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'failed' THEN

IF NEW."status" = 'drafting' THEN
NEW."status" := 'drafting';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'smollm3-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering drafting again needs a new key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'illustrating' THEN
NEW."status" := 'illustrating';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, 'heavy-draft', jsonb_build_object('id', NEW."id"), jsonb_build_object('topic', NEW."topic", 'details', NEW."details", 'locale', NEW."locale", 'region', NEW."region", 'card_count', NEW."card_count", 'audience_key', COALESCE((SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), ''), 'audience', COALESCE((SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id), '')))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering illustrating again needs a new key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => airlock.job_key('heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'idle' THEN
NEW."status" := 'idle';
RETURN NEW;
END IF;
IF NEW."status" = 'done' THEN
NEW."status" := 'done';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'generation_draft', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_generation_draft_status_machine" ON "generation_draft";
CREATE TRIGGER "trg_generation_draft_status_machine"
  BEFORE INSERT OR UPDATE OR DELETE ON "generation_draft"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_generation_draft_status_machine"();

ALTER TABLE "card_art" DROP CONSTRAINT IF EXISTS "card_art_status_check";
ALTER TABLE "card_art" ADD CONSTRAINT "card_art_status_check" CHECK ("status" IN ('waiting', 'pending', 'drawn', 'failed', 'unknown')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_card_art_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD' AS $$
DECLARE
  outcome jsonb;
  cortex_event text;
  cortex_payload jsonb;
  cortex_rows integer;
  cortex_changed integer := 0;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('pending') THEN
      RAISE EXCEPTION '% in % awaits an outcome and is not deleted', 'card_art', OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'pending' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."redraws" IS DISTINCT FROM NEW."redraws" OR OLD."run" IS DISTINCT FROM NEW."run") THEN
    RAISE EXCEPTION '% in pending keeps its key until the outcome of %', 'card_art', 'illustrate-card:' || jsonb_build_array(OLD."id"::text, OLD."run"::text, OLD."redraws"::text)::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND relation = TG_RELID AND depth = pg_trigger_depth() AND machine = 'card_art' AND row_key = OLD."id"::text
      RETURNING event, payload INTO cortex_event, cortex_payload;
    IF FOUND THEN
    IF OLD."status" = 'waiting' THEN
IF cortex_event = 'facts.art' THEN

IF (cortex_payload->>'detail' <> '') IS TRUE THEN
NEW."status" := 'failed';
        UPDATE "flashcard" SET "back" = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E' WHERE id = NEW.card_id
  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3));
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF (cortex_payload->>'detail' = '' AND NOT (cortex_payload->>'previous_pending')::boolean) IS TRUE THEN
NEW."status" := 'pending';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, 'illustrate-card', jsonb_build_object('id', NEW."id"), jsonb_build_object('level', NEW."level", 'position', NEW."position", 'description', NEW."description", 'redraws', NEW."redraws", 'word', (SELECT f.front FROM flashcard f WHERE f.id = NEW.card_id), 'title', (SELECT s.name FROM card_set s WHERE s.id = NEW.set_id), 'details', (SELECT s.details FROM card_set s WHERE s.id = NEW.set_id), 'audience_key', (SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), 'audience', (SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id)))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering pending again needs a new key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => airlock.job_key('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
IF cortex_event = 'start' THEN
NEW."status" := 'pending';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, 'illustrate-card', jsonb_build_object('id', NEW."id"), jsonb_build_object('level', NEW."level", 'position', NEW."position", 'description', NEW."description", 'redraws', NEW."redraws", 'word', (SELECT f.front FROM flashcard f WHERE f.id = NEW.card_id), 'title', (SELECT s.name FROM card_set s WHERE s.id = NEW.set_id), 'details', (SELECT s.details FROM card_set s WHERE s.id = NEW.set_id), 'audience_key', (SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), 'audience', (SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id)))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering pending again needs a new key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => airlock.job_key('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'refuse' THEN
NEW."status" := 'failed';
        UPDATE "flashcard" SET "back" = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E' WHERE id = NEW.card_id
  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3));
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'pending' THEN
RETURN NULL;
    END IF;
    IF OLD."status" = 'drawn' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'waiting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'failed' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'waiting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'unknown' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'waiting';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
RETURN NULL;
    END IF;
      RETURN NULL;
    END IF;
  END IF;  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'waiting' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'card_art', 'waiting', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'waiting' THEN

IF NEW."status" = 'pending' THEN
NEW."status" := 'pending';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, 'illustrate-card', jsonb_build_object('id', NEW."id"), jsonb_build_object('level', NEW."level", 'position', NEW."position", 'description', NEW."description", 'redraws', NEW."redraws", 'word', (SELECT f.front FROM flashcard f WHERE f.id = NEW.card_id), 'title', (SELECT s.name FROM card_set s WHERE s.id = NEW.set_id), 'details', (SELECT s.details FROM card_set s WHERE s.id = NEW.set_id), 'audience_key', (SELECT s.audience_key FROM card_set s WHERE s.id = NEW.set_id), 'audience', (SELECT s.audience FROM card_set s WHERE s.id = NEW.set_id)))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering pending again needs a new key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => airlock.job_key('illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
        UPDATE "flashcard" SET "back" = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E' WHERE id = NEW.card_id
  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3));
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'card_art', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'pending' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'illustrate-card:' || jsonb_build_array(OLD."id"::text, OLD."run"::text, OLD."redraws"::text)::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves pending only by the recorded outcome of %', 'card_art', 'illustrate-card:' || jsonb_build_array(OLD."id"::text, OLD."run"::text, OLD."redraws"::text)::text USING ERRCODE = 'check_violation';
      END IF;
IF NEW."status" = 'drawn' AND outcome->>'kind' = 'done' THEN
NEW."status" := 'drawn';
        NEW."detail" := '';
        UPDATE "flashcard" SET "back" = outcome->'data'->>'image' WHERE id = NEW.card_id;
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
RETURN NEW;
END IF;
IF NEW."status" = 'failed' AND outcome->>'kind' <> 'done' THEN

IF (outcome->>'kind' = 'unknown') IS TRUE THEN
NEW."status" := 'unknown';
        NEW."detail" := COALESCE(outcome->>'data', outcome->>'kind');
        UPDATE "flashcard" SET "back" = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E' WHERE id = NEW.card_id
  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3));
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
RETURN NEW;
ELSE
NEW."status" := 'failed';
        NEW."detail" := COALESCE(outcome->>'data', outcome->>'kind');
        UPDATE "flashcard" SET "back" = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20256%20256%22%20width%3D%22256%22%20height%3D%22256%22%20data-tier%3D%22tier-none%22%3E%3Crect%20width%3D%22256%22%20height%3D%22256%22%20fill%3D%22%23FFFFFF%22%2F%3E%3Crect%20x%3D%2288%22%20y%3D%2280%22%20width%3D%2280%22%20height%3D%2264%22%20rx%3D%228%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Ccircle%20cx%3D%22111%22%20cy%3D%22102%22%20r%3D%226%22%20fill%3D%22%23A8A29E%22%2F%3E%3Cpath%20d%3D%22M89%20135l24-22%2016%2014%2013-12%2025%2022%22%20fill%3D%22none%22%20stroke%3D%22%23A8A29E%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M80%20160L176%2064%22%20stroke%3D%22%23DC2626%22%20stroke-width%3D%224%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E' WHERE id = NEW.card_id
  AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.id <> NEW.id AND s.status IN ('waiting', 'pending', 'drawn'))
  AND (NEW.level = 3 OR EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = NEW.card_id AND s.level = 3));
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
RETURN NEW;
END IF;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'card_art', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'drawn' THEN

IF NEW."status" = 'waiting' THEN
NEW."status" := 'waiting';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'card_art', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'failed' THEN

IF NEW."status" = 'waiting' THEN
NEW."status" := 'waiting';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'card_art', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'unknown' THEN

IF NEW."status" = 'waiting' THEN
NEW."status" := 'waiting';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'card_art', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_card_art_status_machine" ON "card_art";
CREATE TRIGGER "trg_card_art_status_machine"
  BEFORE INSERT OR UPDATE OR DELETE ON "card_art"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_card_art_status_machine"();

ALTER TABLE "flashcard" DROP CONSTRAINT IF EXISTS "flashcard_redraw_check";
ALTER TABLE "flashcard" ADD CONSTRAINT "flashcard_redraw_check" CHECK ("redraw" IN ('settled', 'drawing')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_flashcard_redraw_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  cortex_event text;
  cortex_payload jsonb;
  cortex_rows integer;
  cortex_changed integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND relation = TG_RELID AND depth = pg_trigger_depth() AND machine = 'card_redraw' AND row_key = OLD."id"::text
      RETURNING event, payload INTO cortex_event, cortex_payload;
    IF FOUND THEN
    IF OLD."redraw" = 'settled' THEN
IF cortex_event = 'draw' THEN

IF (EXISTS (SELECT 1 FROM card_art a WHERE a.id = NEW.id || ':3' AND a.status IN ('drawn', 'failed', 'unknown'))) IS TRUE THEN
NEW."redraw" := 'drawing';
        UPDATE "card_art" SET "status" = 'waiting', "detail" = '', "description" = NEW.description, "redraws" = redraws + 1 WHERE id = NEW.id || ':3' AND status IN ('drawn', 'failed', 'unknown');
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
IF NEW."redraw" IS NOT DISTINCT FROM OLD."redraw" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
RETURN NULL;
    END IF;
    IF OLD."redraw" = 'drawing' THEN
IF cortex_event = 'settle' THEN
NEW."redraw" := 'settled';
IF NEW."redraw" IS NOT DISTINCT FROM OLD."redraw" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.redraw' THEN

IF (cortex_payload->>'status' IN ('drawn', 'failed', 'unknown')) IS TRUE THEN
NEW."redraw" := 'settled';
IF NEW."redraw" IS NOT DISTINCT FROM OLD."redraw" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
RETURN NULL;
    END IF;
      RETURN NULL;
    END IF;
  END IF;  IF TG_OP = 'UPDATE' AND OLD."redraw" = NEW."redraw" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."redraw" <> 'settled' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'flashcard', 'settled', NEW."redraw" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."redraw" = 'settled' THEN

IF NEW."redraw" = 'drawing' THEN

IF (EXISTS (SELECT 1 FROM card_art a WHERE a.id = NEW.id || ':3' AND a.status IN ('drawn', 'failed', 'unknown'))) IS TRUE THEN
NEW."redraw" := 'drawing';
        UPDATE "card_art" SET "status" = 'waiting', "detail" = '', "description" = NEW.description, "redraws" = redraws + 1 WHERE id = NEW.id || ':3' AND status IN ('drawn', 'failed', 'unknown');
        GET DIAGNOSTICS cortex_rows = ROW_COUNT;
        cortex_changed := cortex_changed + cortex_rows;
RETURN NEW;
ELSE

RAISE EXCEPTION 'guard failed on Cortex transition' USING ERRCODE = 'check_violation';
END IF;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'flashcard', OLD."redraw", NEW."redraw" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."redraw" = 'drawing' THEN

IF NEW."redraw" = 'settled' THEN
NEW."redraw" := 'settled';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'flashcard', OLD."redraw", NEW."redraw" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_flashcard_redraw_machine" ON "flashcard";
CREATE TRIGGER "trg_flashcard_redraw_machine"
  BEFORE INSERT OR UPDATE ON "flashcard"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_flashcard_redraw_machine"();

ALTER TABLE "deck_level" DROP CONSTRAINT IF EXISTS "deck_level_status_check";
ALTER TABLE "deck_level" ADD CONSTRAINT "deck_level_status_check" CHECK ("status" IN ('running', 'complete', 'partial', 'failed')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_deck_level_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
DECLARE
  cortex_event text;
  cortex_payload jsonb;
  cortex_rows integer;
  cortex_changed integer := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    DELETE FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND relation = TG_RELID AND depth = pg_trigger_depth() AND machine = 'deck_level' AND row_key = OLD."id"::text
      RETURNING event, payload INTO cortex_event, cortex_payload;
    IF FOUND THEN
    IF OLD."status" = 'running' THEN
IF cortex_event = 'complete' THEN
NEW."status" := 'complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'short' THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'fail' THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.level' THEN

IF ((cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer) IS TRUE THEN
NEW."status" := 'complete';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF ((cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer = 0) IS TRUE THEN
NEW."status" := 'failed';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

IF ((cortex_payload->>'pending')::integer = 0 AND (cortex_payload->>'drawn')::integer > 0 AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer) IS TRUE THEN
NEW."status" := 'partial';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
END IF;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'complete' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.level' THEN

IF ((cortex_payload->>'pending')::integer > 0 OR (NEW.status = 'complete' AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer)
OR (NEW.status = 'failed' AND (cortex_payload->>'drawn')::integer > 0)
OR (NEW.status = 'partial' AND ((cortex_payload->>'drawn')::integer = 0 OR (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer))) IS TRUE THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'partial' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.level' THEN

IF ((cortex_payload->>'pending')::integer > 0 OR (NEW.status = 'complete' AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer)
OR (NEW.status = 'failed' AND (cortex_payload->>'drawn')::integer > 0)
OR (NEW.status = 'partial' AND ((cortex_payload->>'drawn')::integer = 0 OR (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer))) IS TRUE THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
RETURN NULL;
    END IF;
    IF OLD."status" = 'failed' THEN
IF cortex_event = 'restart' THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
END IF;
IF cortex_event = 'facts.level' THEN

IF ((cortex_payload->>'pending')::integer > 0 OR (NEW.status = 'complete' AND (cortex_payload->>'drawn')::integer < (cortex_payload->>'total')::integer)
OR (NEW.status = 'failed' AND (cortex_payload->>'drawn')::integer > 0)
OR (NEW.status = 'partial' AND ((cortex_payload->>'drawn')::integer = 0 OR (cortex_payload->>'drawn')::integer = (cortex_payload->>'total')::integer))) IS TRUE THEN
NEW."status" := 'running';
IF NEW."status" IS NOT DISTINCT FROM OLD."status" AND cortex_changed = 0 THEN RETURN NULL; END IF;
RETURN NEW;
ELSE

RETURN NULL;
END IF;
END IF;
RETURN NULL;
    END IF;
      RETURN NULL;
    END IF;
  END IF;  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'running' THEN
      -- A seed restores its row in the state it names, entering
      -- nothing (900_seed.sql marks its session as seeding). Any
      -- session may set the mark, so it counts only where the session
      -- logged in as the table's owner, as the seed's runner does; a
      -- client logs in as authenticator.
      IF coalesce(current_setting('pronto.seed', true), '') = 'on'
        AND pg_has_role(session_user, (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID), 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'deck_level', 'running', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'running' THEN

IF NEW."status" = 'complete' THEN
NEW."status" := 'complete';
RETURN NEW;
END IF;
IF NEW."status" = 'partial' THEN
NEW."status" := 'partial';
RETURN NEW;
END IF;
IF NEW."status" = 'failed' THEN
NEW."status" := 'failed';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_level', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'complete' THEN

IF NEW."status" = 'running' THEN
NEW."status" := 'running';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_level', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'partial' THEN

IF NEW."status" = 'running' THEN
NEW."status" := 'running';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_level', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'failed' THEN

IF NEW."status" = 'running' THEN
NEW."status" := 'running';
RETURN NEW;
END IF;


      RAISE EXCEPTION 'invalid transition on % from % to %', 'deck_level', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_deck_level_status_machine" ON "deck_level";
CREATE TRIGGER "trg_deck_level_status_machine"
  BEFORE INSERT OR UPDATE ON "deck_level"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_deck_level_status_machine"();
