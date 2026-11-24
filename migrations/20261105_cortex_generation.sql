SET LOCAL lock_timeout = '5s';
LOCK TABLE public.card_art, public.card_set, public.card_translation, public.deck_level,
  public.deck_progress, public.deck_translation, public.flashcard, public.generation_draft
  IN SHARE ROW EXCLUSIVE MODE;

-- services/database/migrations/010_machines.sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';


CREATE SCHEMA IF NOT EXISTS cortex_runtime;
REVOKE ALL ON SCHEMA cortex_runtime FROM PUBLIC;
CREATE TABLE IF NOT EXISTS cortex_runtime.dispatch_frame (
  backend integer NOT NULL, xid bigint NOT NULL, relation oid NOT NULL, depth integer NOT NULL,
  machine text NOT NULL, row_key text NOT NULL, event text NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY (backend, xid, relation, depth, machine, row_key)
);
CREATE TABLE IF NOT EXISTS cortex_runtime.draining (
  backend integer NOT NULL, xid bigint NOT NULL, name text NOT NULL,
  dirty boolean NOT NULL DEFAULT false,
  depth integer NOT NULL DEFAULT 0, flushing boolean NOT NULL DEFAULT false,
  pending text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (backend, xid, name)
);
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS flushing boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS pending text[] NOT NULL DEFAULT '{}';
ALTER TABLE cortex_runtime.dispatch_frame ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex_runtime.draining ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE g record;
BEGIN
  FOR g IN
    SELECT DISTINCT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, a.grantee
      FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE n.nspname = 'cortex_runtime' AND a.grantee <> n.nspowner
    UNION
    SELECT DISTINCT 'TABLE', 'cortex_runtime.' || quote_ident(c.relname), a.grantee
      FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid IN ('cortex_runtime.dispatch_frame'::regclass, 'cortex_runtime.draining'::regclass) AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM %s', g.kind, g.name,
      CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(g.grantee)) END);
  END LOOP;
END $$;

INSERT INTO mecha.rls_exempt VALUES
  ('cortex_runtime.dispatch_frame', 'private owner-only dispatch state; app roles have no access'),
  ('cortex_runtime.draining', 'private owner-only drain state; app roles have no access')
ON CONFLICT (table_name) DO UPDATE SET reason = EXCLUDED.reason;

CREATE OR REPLACE FUNCTION "trg_generation_draft_GenerationProvision_reducer"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  items jsonb;
  event jsonb;
  v text;
BEGIN
  items := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
  event := jsonb_build_object('type', lower(TG_OP), 'row', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
  IF TG_OP = 'INSERT' THEN

        INSERT INTO "generation_draft" ("id", "topic", "category", "locale", "region", "card_count", "status", "set_id", "details") VALUES (split_part(NEW.id, ':', 1) || ':draft-cheap', '', '', NEW.locale, '', 0, 'idle', '', '') ON CONFLICT ("id") DO NOTHING;
        INSERT INTO "generation_draft" ("id", "topic", "category", "locale", "region", "card_count", "status", "set_id", "details") VALUES (split_part(NEW.id, ':', 1) || ':draft-heavy', '', '', NEW.locale, '', 0, 'idle', '', '') ON CONFLICT ("id") DO NOTHING;
    RETURN NEW;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

REVOKE EXECUTE ON FUNCTION "trg_generation_draft_GenerationProvision_reducer"() FROM PUBLIC;
DROP TRIGGER IF EXISTS "trg_generation_draft_GenerationProvision_reducer" ON "generation_draft";
CREATE TRIGGER "trg_generation_draft_GenerationProvision_reducer"
  AFTER INSERT OR UPDATE OR DELETE ON "generation_draft"
  FOR EACH ROW EXECUTE FUNCTION "trg_generation_draft_GenerationProvision_reducer"();

CREATE OR REPLACE FUNCTION "trg_card_set_ProgressProvision_reducer"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  items jsonb;
  event jsonb;
  v text;
BEGIN
  items := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
  event := jsonb_build_object('type', lower(TG_OP), 'row', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
  IF TG_OP = 'INSERT' THEN

        INSERT INTO "deck_progress" ("id", "run", "status") VALUES (NEW.id, 'run-0', 'drafting') ON CONFLICT ("id") DO NOTHING;
        PERFORM snapcards_bootstrap_generation(NEW.device, NEW.locale);
    RETURN NEW;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

REVOKE EXECUTE ON FUNCTION "trg_card_set_ProgressProvision_reducer"() FROM PUBLIC;
DROP TRIGGER IF EXISTS "trg_card_set_ProgressProvision_reducer" ON "card_set";
CREATE TRIGGER "trg_card_set_ProgressProvision_reducer"
  AFTER INSERT OR UPDATE OR DELETE ON "card_set"
  FOR EACH ROW EXECUTE FUNCTION "trg_card_set_ProgressProvision_reducer"();

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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'smollm3-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text), job_key => 'heavy-draft:' || jsonb_build_array(NEW."id"::text, NEW."topic"::text, NEW."locale"::text, NEW."region"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, max_attempts => 30);
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
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text), job_key => 'illustrate-card:' || jsonb_build_array(NEW."id"::text, NEW."run"::text, NEW."redraws"::text)::text, max_attempts => 30);
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


-- services/database/sql/017_card_art_fan_out.sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';


CREATE OR REPLACE FUNCTION snapcards_bootstrap_generation(device text, locale text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
  SELECT device || ':draft-cheap', '', '', locale, '', 0, 'idle', '', '' WHERE device <> ''
  ON CONFLICT (id) DO NOTHING
$$;
REVOKE ALL ON FUNCTION snapcards_bootstrap_generation(text, text) FROM PUBLIC;

-- A text level's outcome, from GenerationMachine's trigger: the deck's cards,
-- in position order, take the level's words in order and one card_art row
-- each. Missing words and refused text are materialized as detail; Cortex
-- connections choose the next transition from these facts. The cards are the
-- deck's rows, not the text's count, since a reader may delete a card between the two levels.
CREATE OR REPLACE FUNCTION snapcards_fan_out_art(deck text, region text, art_level integer, outcome jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_run text := substring(region FROM 'run-[0-9]+$');
  v_cards jsonb;
  v_card jsonb;
  v_deck_card record;
  v_card_id text;
  v_art_id text;
  v_word text;
  v_refusal text;
BEGIN
  -- A translation writes no deck.
  IF deck = '' THEN
    RETURN;
  END IF;
  -- generation_draft is open to every reader, so a slot can name any deck; a curated one has no device.
  IF v_run IS NULL OR EXISTS (SELECT 1 FROM card_set s WHERE s.id = deck AND s.device = '') THEN
    RAISE EXCEPTION 'art fan-out needs a generated deck and a run-<n> region, got % and %', deck, region;
  END IF;
  IF outcome->>'kind' = 'done' THEN
    v_cards := (outcome->'data'->>'cards_json')::jsonb;
  ELSE
    v_refusal := COALESCE(outcome->>'data', outcome->>'kind');
  END IF;
  FOR v_deck_card IN
    SELECT f.id, substring(f.id FROM '-([0-9]+)$')::integer AS position,
           row_number() OVER (ORDER BY substring(f.id FROM '-([0-9]+)$')::integer) AS ordinal
    FROM flashcard f WHERE f.set_id = deck
  LOOP
    v_card_id := v_deck_card.id;
    v_art_id := v_card_id || ':' || art_level;
    v_card := v_cards->(v_deck_card.ordinal::integer - 1);
    v_word := NULLIF(btrim(v_card->>'word'), '');
    UPDATE flashcard f SET
        front = v_word,
        emoji = COALESCE(NULLIF(v_card->>'emoji', ''), f.emoji),
        color = COALESCE(NULLIF(v_card->>'color', ''), f.color)
      WHERE f.id = v_card_id AND v_word IS NOT NULL
        AND (f.front, f.emoji, f.color) IS DISTINCT FROM
            (v_word, COALESCE(NULLIF(v_card->>'emoji', ''), f.emoji), COALESCE(NULLIF(v_card->>'color', ''), f.color));
    -- A rewritten word is translated anew, whichever language it was read in.
    IF FOUND THEN
      DELETE FROM card_translation WHERE set_id = deck;
      DELETE FROM deck_translation WHERE set_id = deck;
    END IF;
    -- A row of this run is already fanned out; one still awaiting an earlier run's image keeps it.
    -- A new run draws the card's word, not a reader's earlier redraw.
    INSERT INTO card_art (id, card_id, set_id, run, level, position, status, detail)
      VALUES (v_art_id, v_card_id, deck, v_run, art_level, v_deck_card.position, 'waiting',
        CASE WHEN v_word IS NULL THEN COALESCE(v_refusal, 'the text named no word for this card') ELSE '' END)
      ON CONFLICT (id) DO UPDATE SET run = EXCLUDED.run,
        position = EXCLUDED.position, status = 'waiting', detail = EXCLUDED.detail, description = ''
      WHERE card_art.status <> 'pending' AND card_art.run <> EXCLUDED.run;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION snapcards_fan_out_art(text, text, integer, jsonb) FROM PUBLIC;

-- services/database/sql/018_deck_level.sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE EXTENSION IF NOT EXISTS pg_ivm VERSION '1.13';
DO $$ BEGIN
  IF (SELECT extversion FROM pg_extension WHERE extname = 'pg_ivm') <> '1.13' THEN
    RAISE EXCEPTION 'Snapcards requires pg_ivm 1.13';
  END IF;
END $$;
CREATE SCHEMA snapcards_facts;
REVOKE ALL ON SCHEMA snapcards_facts FROM PUBLIC;

SELECT pgivm.create_immv('snapcards_facts.art_counts', $query$
  SELECT a.set_id, a.level, max(substring(a.run FROM 5)::integer) AS run_number,
         count(*) AS total,
         sum(CASE WHEN a.status = 'drawn' THEN 1 ELSE 0 END) AS drawn,
         sum(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) AS failed,
         sum(CASE WHEN a.status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
         sum(CASE WHEN a.status IN ('waiting', 'pending') THEN 1 ELSE 0 END) AS pending
  FROM public.card_art a JOIN public.flashcard f ON f.id = a.card_id
  GROUP BY a.set_id, a.level
$query$);
SELECT pgivm.create_immv('snapcards_facts.newest_runs', $query$
  SELECT f.set_id, max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer) AS run_number
  FROM public.flashcard f GROUP BY f.set_id
$query$);
REVOKE ALL ON ALL TABLES IN SCHEMA snapcards_facts FROM PUBLIC;

CREATE OR REPLACE FUNCTION snapcards_newest_runs() RETURNS TABLE (set_id text, run text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT set_id, 'run-' || run_number FROM snapcards_facts.newest_runs WHERE run_number IS NOT NULL
$$;
REVOKE ALL ON FUNCTION snapcards_newest_runs() FROM PUBLIC;

CREATE OR REPLACE FUNCTION snapcards_count_art() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE counts snapcards_facts.art_counts[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  SELECT coalesce(array_agg(a), ARRAY[]::snapcards_facts.art_counts[]) INTO counts FROM snapcards_facts.art_counts a;

  INSERT INTO deck_level (id, set_id, level, run, total, drawn, failed, unknown, pending, status)
  SELECT set_id || ':' || level, set_id, level, 'run-' || run_number,
         total::integer, drawn::integer, failed::integer, unknown::integer, pending::integer, 'running'
  FROM unnest(counts)
  ON CONFLICT (id) DO UPDATE SET run = EXCLUDED.run, total = EXCLUDED.total, drawn = EXCLUDED.drawn, failed = EXCLUDED.failed,
    unknown = EXCLUDED.unknown, pending = EXCLUDED.pending
  WHERE (deck_level.run, deck_level.total, deck_level.drawn, deck_level.failed, deck_level.unknown, deck_level.pending)
    IS DISTINCT FROM (EXCLUDED.run, EXCLUDED.total, EXCLUDED.drawn, EXCLUDED.failed, EXCLUDED.unknown, EXCLUDED.pending);

  SELECT coalesce(array_agg(a), ARRAY[]::snapcards_facts.art_counts[]) INTO counts FROM snapcards_facts.art_counts a;
  DELETE FROM deck_level d WHERE NOT EXISTS (
    SELECT 1 FROM unnest(counts) a WHERE a.set_id = d.set_id AND a.level = d.level);

  DELETE FROM card_art a WHERE a.status <> 'pending' AND NOT EXISTS (SELECT 1 FROM flashcard f WHERE f.id = a.card_id);

  DELETE FROM deck_progress p WHERE NOT EXISTS (SELECT 1 FROM card_set s WHERE s.id = p.id);

  PERFORM snapcards_advance_decks();
END $$;

REVOKE ALL ON FUNCTION snapcards_count_art() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION snapcards_count_art() TO service;

-- services/database/migrations/019_deck_advance.sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';


CREATE SCHEMA IF NOT EXISTS mecha;
GRANT USAGE ON SCHEMA mecha TO PUBLIC;
CREATE OR REPLACE FUNCTION mecha.request_write_gate() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
END $$;
CREATE OR REPLACE FUNCTION cortex_runtime."gate_snapcards_advance_decks"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('pronto.cortex', 0)) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'Cortex source gate is busy; retry the transaction';
  END IF;
  INSERT INTO cortex_runtime.draining (backend, xid, name, depth)
    VALUES (pg_backend_pid(), txid_current(), '@statements', 1)
    ON CONFLICT (backend, xid, name) DO UPDATE SET depth = cortex_runtime.draining.depth + 1;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."gate_snapcards_advance_decks"() FROM PUBLIC;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS dirty boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS flushing boolean NOT NULL DEFAULT false;
ALTER TABLE cortex_runtime.draining ADD COLUMN IF NOT EXISTS pending text[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION cortex_runtime.mark_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE cortex_runtime.draining SET dirty = true WHERE backend = pg_backend_pid() AND xid = txid_current() AND name <> '@statements' AND NOT dirty;
  IF TG_ARGV[1] = 'true' THEN
    UPDATE cortex_runtime.draining SET pending = array_append(pending, TG_ARGV[0])
      WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND NOT TG_ARGV[0] = ANY(pending)
        AND NOT EXISTS (SELECT 1 FROM cortex_runtime.draining active WHERE active.backend = pg_backend_pid() AND active.xid = txid_current() AND active.name = TG_ARGV[0]);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime.mark_dirty() FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime.finish_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE remaining integer; busy boolean; next_group text;
BEGIN
  UPDATE cortex_runtime.draining SET depth = depth - 1
    WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements'
    RETURNING depth, flushing INTO remaining, busy;
  IF NOT FOUND OR remaining < 0 THEN RAISE EXCEPTION 'Cortex statement barrier is unbalanced'; END IF;
  IF remaining > 0 OR busy THEN RETURN NULL; END IF;
  UPDATE cortex_runtime.draining SET flushing = true WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
  FOR flush_pass IN 1..100 LOOP
    SELECT pending[1] INTO next_group FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
    EXIT WHEN next_group IS NULL;
    UPDATE cortex_runtime.draining SET pending = array_remove(pending, next_group) WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements';
    EXECUTE format('SELECT public.%I()', next_group);
  END LOOP;
  DELETE FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND depth = 0 AND cardinality(pending) = 0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cortex pending source groups did not settle in 100 passes'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime.finish_statement() FROM PUBLIC;
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."card_art";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."card_art";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."card_art" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."card_art";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_art" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."card_art";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_art" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."card_set";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."card_set";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."card_set" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."card_set";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_set" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."card_set";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_set" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."card_translation";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."card_translation";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."card_translation" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."card_translation";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_translation" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."card_translation";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."card_translation" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."deck_level";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."deck_level";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."deck_level" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."deck_level";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_level" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."deck_level";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_level" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."deck_progress";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."deck_progress";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."deck_progress" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."deck_progress";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_progress" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'false');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."deck_progress";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_progress" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."deck_translation";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."deck_translation";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."deck_translation" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."deck_translation";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_translation" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."deck_translation";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."deck_translation" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."flashcard";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."flashcard";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."flashcard" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."flashcard";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."flashcard" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."flashcard";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."flashcard" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "Cortex_snapcards_advance_decks_gate" ON "public"."generation_draft";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_gate" ON "public"."generation_draft";
CREATE TRIGGER "cortex_snapcards_advance_decks_gate" BEFORE INSERT OR UPDATE OR DELETE ON "public"."generation_draft" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime."gate_snapcards_advance_decks"();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks_dirty" ON "public"."generation_draft";
CREATE TRIGGER "cortex_snapcards_advance_decks_dirty" AFTER INSERT OR UPDATE OR DELETE ON "public"."generation_draft" FOR EACH ROW EXECUTE FUNCTION cortex_runtime.mark_dirty('snapcards_advance_decks', 'true');
DROP TRIGGER IF EXISTS "zzzz_cortex_snapcards_advance_decks" ON "public"."generation_draft";
CREATE TRIGGER "zzzz_cortex_snapcards_advance_decks" AFTER INSERT OR UPDATE OR DELETE ON "public"."generation_draft" FOR EACH STATEMENT EXECUTE FUNCTION cortex_runtime.finish_statement();
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "card_set";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "flashcard";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "generation_draft";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "card_art";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "deck_level";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "card_translation";
DROP TRIGGER IF EXISTS "cortex_snapcards_advance_decks" ON "deck_translation";
CREATE OR REPLACE FUNCTION cortex_runtime."dispatch_deck_progress"(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public."deck_progress" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), 'public."deck_progress"'::regclass::oid, pg_trigger_depth() + 1, 'deck_progress', instance_key, event_name, event_payload);
  UPDATE public."deck_progress" SET "status" = "status" WHERE "id"::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = 'deck_progress' AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."dispatch_deck_progress"(text, text, jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."query_deck_progress_0"(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  PERFORM 1 FROM public."deck_progress" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (SELECT n.set_id AS key, 'facts.progress' AS event, jsonb_build_object('run', n.run, 'level2', l2.status, 'level3', l3.status) AS payload
FROM snapcards_newest_runs() n
LEFT JOIN deck_level l2 ON l2.set_id = n.set_id AND l2.level = 2 AND l2.run = n.run
LEFT JOIN deck_level l3 ON l3.set_id = n.set_id AND l3.level = 3 AND l3.run = n.run) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM 'facts.progress' OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'deck_progress.levels';
  END IF;
  RETURN cortex_runtime."dispatch_deck_progress"(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."query_deck_progress_0"(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."dispatch_generation"(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public."generation_draft" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), 'public."generation_draft"'::regclass::oid, pg_trigger_depth() + 1, 'generation', instance_key, event_name, event_payload);
  UPDATE public."generation_draft" SET "status" = "status" WHERE "id"::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = 'generation' AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."dispatch_generation"(text, text, jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."query_generation_0"(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  PERFORM 1 FROM public."generation_draft" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (SELECT s.device || ':draft-' || tier.name AS key, 'facts.text' AS event,
       jsonb_build_object('tier', tier.name, 'candidates', jsonb_agg(
         jsonb_build_object('id', s.id, 'name', s.name, 'details', s.details, 'locale', s.locale,
           'cover', s.cover_emoji, 'expected', s.count, 'cards', facts.cards, 'run', facts.run,
           'region', CASE WHEN s.region = '' THEN 'run-' || facts.run ELSE s.region || ' :: run-' || facts.run END,
           'has_art', EXISTS (SELECT 1 FROM card_art a WHERE a.set_id = s.id AND a.level = tier.level AND a.run = 'run-' || facts.run))
         ORDER BY s.category DESC, s.id)) AS payload
FROM card_set s CROSS JOIN (VALUES ('cheap', 2), ('heavy', 3)) AS tier(name, level)
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS cards,
         CASE WHEN tier.name = 'cheap' THEN max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer)
              ELSE (SELECT max(substring(a.run FROM 5)::integer) FROM card_art a WHERE a.set_id = s.id AND a.level = 2) END AS run
  FROM flashcard f WHERE f.set_id = s.id
) facts
WHERE s.device <> ''
GROUP BY s.device, tier.name, tier.level) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM 'facts.text' OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'generation.candidates';
  END IF;
  RETURN cortex_runtime."dispatch_generation"(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."query_generation_0"(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."dispatch_card_art"(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public."card_art" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), 'public."card_art"'::regclass::oid, pg_trigger_depth() + 1, 'card_art', instance_key, event_name, event_payload);
  UPDATE public."card_art" SET "status" = "status" WHERE "id"::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = 'card_art' AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."dispatch_card_art"(text, text, jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."query_card_art_0"(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  PERFORM 1 FROM public."card_art" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (SELECT a.id AS key, 'facts.art' AS event,
  jsonb_build_object('detail', a.detail, 'previous_pending', EXISTS (
    SELECT 1 FROM card_art previous WHERE previous.card_id = a.card_id AND previous.level = a.level - 1
      AND previous.status IN ('waiting', 'pending'))) AS payload
FROM card_art a) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM 'facts.art' OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'card_art.artFacts';
  END IF;
  RETURN cortex_runtime."dispatch_card_art"(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."query_card_art_0"(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."dispatch_card_redraw"(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public."flashcard" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), 'public."flashcard"'::regclass::oid, pg_trigger_depth() + 1, 'card_redraw', instance_key, event_name, event_payload);
  UPDATE public."flashcard" SET "redraw" = "redraw" WHERE "id"::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = 'card_redraw' AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."dispatch_card_redraw"(text, text, jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."query_card_redraw_0"(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  PERFORM 1 FROM public."flashcard" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (SELECT a.card_id AS key, 'facts.redraw' AS event, jsonb_build_object('status', a.status) AS payload FROM card_art a WHERE a.level = 3) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM 'facts.redraw' OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'card_redraw.artFacts';
  END IF;
  RETURN cortex_runtime."dispatch_card_redraw"(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."query_card_redraw_0"(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."dispatch_deck_level"(instance_key text, event_name text, event_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE affected integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  IF instance_key IS NULL OR event_name IS NULL OR event_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex dispatch requires key, event and payload';
  END IF;
  PERFORM 1 FROM public."deck_level" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO cortex_runtime.dispatch_frame (backend, xid, relation, depth, machine, row_key, event, payload)
    VALUES (pg_backend_pid(), txid_current(), 'public."deck_level"'::regclass::oid, pg_trigger_depth() + 1, 'deck_level', instance_key, event_name, event_payload);
  UPDATE public."deck_level" SET "status" = "status" WHERE "id"::text = instance_key;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM cortex_runtime.dispatch_frame WHERE backend = pg_backend_pid() AND xid = txid_current() AND machine = 'deck_level' AND row_key = instance_key) THEN
    RAISE EXCEPTION 'Cortex dispatch frame was not consumed';
  END IF;
  RETURN affected > 0;
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."dispatch_deck_level"(text, text, jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION cortex_runtime."query_deck_level_0"(instance_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_count bigint; v_event text; v_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  PERFORM 1 FROM public."deck_level" WHERE "id"::text = instance_key FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*), (array_agg(cortex_source.event::text))[1], (array_agg(cortex_source.payload::jsonb))[1]
    INTO v_count, v_event, v_payload
    FROM (SELECT id AS key, 'facts.level' AS event, jsonb_build_object('pending', pending, 'drawn', drawn, 'total', total) AS payload FROM deck_level) AS cortex_source WHERE cortex_source.key::text = instance_key;
  IF v_count > 1 THEN RAISE EXCEPTION 'Cortex query returned duplicate instance %', instance_key; END IF;
  IF v_count = 0 THEN RETURN false; END IF;
  IF v_event IS DISTINCT FROM 'facts.level' OR v_payload IS NULL THEN
    RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'deck_level.counts';
  END IF;
  RETURN cortex_runtime."dispatch_deck_level"(instance_key, v_event, v_payload);
END $$;
REVOKE ALL ON FUNCTION cortex_runtime."query_deck_level_0"(text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION "snapcards_advance_decks"() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE source record; v_snapshot jsonb; v_changed boolean; v_dirty boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pronto.cortex', 0));
  UPDATE cortex_runtime.draining SET pending = CASE WHEN 'snapcards_advance_decks' = ANY(pending) THEN pending ELSE array_append(pending, 'snapcards_advance_decks') END
    WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = '@statements' AND depth > 0;
  IF FOUND THEN RETURN; END IF;
  INSERT INTO cortex_runtime.draining (backend, xid, name) VALUES (pg_backend_pid(), txid_current(), 'snapcards_advance_decks') ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  FOR pass IN 1..100 LOOP
    v_changed := false;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (SELECT n.set_id AS key, 'facts.progress' AS event, jsonb_build_object('run', n.run, 'level2', l2.status, 'level3', l3.status) AS payload
FROM snapcards_newest_runs() n
LEFT JOIN deck_level l2 ON l2.set_id = n.set_id AND l2.level = 2 AND l2.run = n.run
LEFT JOIN deck_level l3 ON l3.set_id = n.set_id AND l3.level = 3 AND l3.run = n.run) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', 'deck_progress.levels';
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', 'deck_progress.levels';
      END IF;
      IF source.event IS DISTINCT FROM 'facts.progress' OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'deck_progress.levels';
      END IF;
      IF EXISTS (SELECT 1 FROM public."deck_progress" AS destination WHERE destination."id"::text = source.key::text AND destination."status" IN ('drafting', 'drawing2', 'drawing23', 'drawn2_complete', 'drawn2_partial', 'drawn2_failed', 'drawing3_complete', 'drawing3_partial', 'drawing3_failed', 'done', 'partial', 'failed')) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN
          IF cortex_runtime."query_deck_progress_0"(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF cortex_runtime."dispatch_deck_progress"(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;
    SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (SELECT s.device || ':draft-' || tier.name AS key, 'facts.text' AS event,
       jsonb_build_object('tier', tier.name, 'candidates', jsonb_agg(
         jsonb_build_object('id', s.id, 'name', s.name, 'details', s.details, 'locale', s.locale,
           'cover', s.cover_emoji, 'expected', s.count, 'cards', facts.cards, 'run', facts.run,
           'region', CASE WHEN s.region = '' THEN 'run-' || facts.run ELSE s.region || ' :: run-' || facts.run END,
           'has_art', EXISTS (SELECT 1 FROM card_art a WHERE a.set_id = s.id AND a.level = tier.level AND a.run = 'run-' || facts.run))
         ORDER BY s.category DESC, s.id)) AS payload
FROM card_set s CROSS JOIN (VALUES ('cheap', 2), ('heavy', 3)) AS tier(name, level)
CROSS JOIN LATERAL (
  SELECT count(*)::integer AS cards,
         CASE WHEN tier.name = 'cheap' THEN max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer)
              ELSE (SELECT max(substring(a.run FROM 5)::integer) FROM card_art a WHERE a.set_id = s.id AND a.level = 2) END AS run
  FROM flashcard f WHERE f.set_id = s.id
) facts
WHERE s.device <> ''
GROUP BY s.device, tier.name, tier.level) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', 'generation.candidates';
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', 'generation.candidates';
      END IF;
      IF source.event IS DISTINCT FROM 'facts.text' OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'generation.candidates';
      END IF;
      IF EXISTS (SELECT 1 FROM public."generation_draft" AS destination WHERE destination."id"::text = source.key::text AND destination."status" IN ('idle', 'done', 'failed')) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN
          IF cortex_runtime."query_generation_0"(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF cortex_runtime."dispatch_generation"(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;
    SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (SELECT a.id AS key, 'facts.art' AS event,
  jsonb_build_object('detail', a.detail, 'previous_pending', EXISTS (
    SELECT 1 FROM card_art previous WHERE previous.card_id = a.card_id AND previous.level = a.level - 1
      AND previous.status IN ('waiting', 'pending'))) AS payload
FROM card_art a) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', 'card_art.artFacts';
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', 'card_art.artFacts';
      END IF;
      IF source.event IS DISTINCT FROM 'facts.art' OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'card_art.artFacts';
      END IF;
      IF EXISTS (SELECT 1 FROM public."card_art" AS destination WHERE destination."id"::text = source.key::text AND destination."status" IN ('waiting')) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN
          IF cortex_runtime."query_card_art_0"(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF cortex_runtime."dispatch_card_art"(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;
    SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (SELECT a.card_id AS key, 'facts.redraw' AS event, jsonb_build_object('status', a.status) AS payload FROM card_art a WHERE a.level = 3) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', 'card_redraw.artFacts';
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', 'card_redraw.artFacts';
      END IF;
      IF source.event IS DISTINCT FROM 'facts.redraw' OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'card_redraw.artFacts';
      END IF;
      IF EXISTS (SELECT 1 FROM public."flashcard" AS destination WHERE destination."id"::text = source.key::text AND destination."redraw" IN ('drawing')) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN
          IF cortex_runtime."query_card_redraw_0"(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF cortex_runtime."dispatch_card_redraw"(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;
    SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    IF v_dirty THEN v_changed := true; END IF;
    UPDATE cortex_runtime.draining SET dirty = false WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'key', cortex_snapshot.key, 'event', cortex_snapshot.event, 'payload', cortex_snapshot.payload,
      'payload_is_sql_null', cortex_snapshot.payload IS NULL
    ) ORDER BY cortex_snapshot.ordinal), '[]'::jsonb) INTO v_snapshot
    FROM (SELECT cortex_input.key::text AS key, cortex_input.event::text AS event,
                 cortex_input.payload::jsonb AS payload, row_number() OVER () AS ordinal
          FROM (SELECT id AS key, 'facts.level' AS event, jsonb_build_object('pending', pending, 'drawn', drawn, 'total', total) AS payload FROM deck_level) AS cortex_input) AS cortex_snapshot;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_snapshot) AS snapshot(item) GROUP BY item->>'key' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'Cortex source % returned duplicate instances', 'deck_level.counts';
    END IF;
    FOR source IN SELECT item->>'key' AS key, item->>'event' AS event,
      CASE WHEN (item->>'payload_is_sql_null')::boolean THEN NULL::jsonb ELSE item->'payload' END AS payload
      FROM jsonb_array_elements(v_snapshot) WITH ORDINALITY AS snapshot(item, ordinal) ORDER BY ordinal LOOP
      IF source.key IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned a null key', 'deck_level.counts';
      END IF;
      IF source.event IS DISTINCT FROM 'facts.level' OR source.payload IS NULL THEN
        RAISE EXCEPTION 'Cortex source % returned an unexpected event or null payload', 'deck_level.counts';
      END IF;
      IF EXISTS (SELECT 1 FROM public."deck_level" AS destination WHERE destination."id"::text = source.key::text AND destination."status" IN ('running', 'complete', 'partial', 'failed')) THEN
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN
          IF cortex_runtime."query_deck_level_0"(source.key::text) THEN v_changed := true; END IF;
        ELSE
          IF cortex_runtime."dispatch_deck_level"(source.key::text, source.event::text, source.payload::jsonb) THEN v_changed := true; END IF;
        END IF;
        SELECT dirty INTO STRICT v_dirty FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
        IF v_dirty THEN v_changed := true; END IF;
      END IF;
    END LOOP;
    IF NOT v_changed THEN
      DELETE FROM cortex_runtime.draining WHERE backend = pg_backend_pid() AND xid = txid_current() AND name = 'snapcards_advance_decks';
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'Cortex composition snapcards_advance_decks did not settle in 100 passes';
END $$;
REVOKE ALL ON FUNCTION "snapcards_advance_decks"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "snapcards_advance_decks"() TO service;



CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  sub text := nullif(current_setting('request.jwt.claims', true)::json->>'sub', '');
BEGIN
  IF sub LIKE '%,%' THEN
    RAISE EXCEPTION 'jwt sub contains a comma, which would split into two scopes';
  END IF;
  PERFORM set_config('app.scopes',
    array_to_string(public.subject_scopes(sub), ','), true);
  IF current_setting('request.method', true) IN ('POST', 'PATCH', 'PUT', 'DELETE') THEN
    PERFORM mecha.request_write_gate();
  END IF;
  IF current_setting('request.method', true) IN ('POST', 'PATCH', 'PUT', 'DELETE')
     AND current_setting('request.path', true) NOT LIKE '/rpc/%' THEN
    PERFORM set_config('response.headers',
      (coalesce(nullif(current_setting('response.headers', true), ''), '[]')::jsonb
        || jsonb_build_array(jsonb_build_object('x-txid', pg_current_xact_id()::xid::text)))::text, true);
  END IF;
END $$;

DO $migration$
DECLARE source text;
BEGIN
  IF to_regprocedure('airlock.snapcards_enqueue_job(text,json,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'bounded generation enqueue is missing';
  END IF;
  source := pg_get_functiondef('public.trg_generation_draft_status_machine()'::regprocedure);
  IF position('graphile_worker.add_job(' in source) = 0 THEN
    RAISE EXCEPTION 'generation trigger has no effect enqueue call';
  END IF;
  EXECUTE replace(source, 'graphile_worker.add_job(', 'airlock.snapcards_enqueue_job(');
END
$migration$;

INSERT INTO public.deck_progress (id, run, status)
SELECT id, 'run-0', 'drafting' FROM public.card_set
ON CONFLICT (id) DO NOTHING;

SELECT public.snapcards_bootstrap_generation(device, locale)
FROM (SELECT DISTINCT ON (device) device, locale FROM public.card_set
      WHERE device <> '' ORDER BY device, id) AS devices;

INSERT INTO public.generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
SELECT device || ':draft-heavy', '', '', locale, '', 0, 'idle', '', ''
FROM (SELECT DISTINCT ON (device) device, locale FROM public.card_set
      WHERE device <> '' ORDER BY device, id) AS devices
ON CONFLICT (id) DO NOTHING;

SELECT public.snapcards_count_art();
