SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The two provisioning reducers restated as the emitter spells them now: a
-- write another trigger makes has no origin, only one a reader sent.
-- 20261113_origin_reducers keeps the bytes a database ran.

CREATE OR REPLACE FUNCTION "trg_generation_draft_GenerationProvision_reducer"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  items jsonb;
  event jsonb;
  v text;
  sender uuid;
BEGIN
  items := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
  -- The origin is who sent the write, as a mecha rule's event names its
  -- sender; a write the service makes has none, nor one another trigger
  -- makes, as a handover's grant. Asked of the token's role, since the
  -- function runs as its owner, and before its subject is read: a
  -- service token's need not be a person's id. A setting a request set
  -- LOCAL reads back as '' once its transaction ends, not NULL.
  IF pg_trigger_depth() = 1 AND nullif(current_setting('request.jwt.claims', true), '')::json->>'role' = 'app_user' THEN
    sender := auth_uid();
  END IF;
  event := jsonb_build_object('type', lower(TG_OP), 'row', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)
    || CASE WHEN sender IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_origin', 'user:' || sender) END;
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
  sender uuid;
BEGIN
  items := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN jsonb_build_array(to_jsonb(OLD)) ELSE '[]'::jsonb END;
  -- The origin is who sent the write, as a mecha rule's event names its
  -- sender; a write the service makes has none, nor one another trigger
  -- makes, as a handover's grant. Asked of the token's role, since the
  -- function runs as its owner, and before its subject is read: a
  -- service token's need not be a person's id. A setting a request set
  -- LOCAL reads back as '' once its transaction ends, not NULL.
  IF pg_trigger_depth() = 1 AND nullif(current_setting('request.jwt.claims', true), '')::json->>'role' = 'app_user' THEN
    sender := auth_uid();
  END IF;
  event := jsonb_build_object('type', lower(TG_OP), 'row', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END)
    || CASE WHEN sender IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('_origin', 'user:' || sender) END;
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

