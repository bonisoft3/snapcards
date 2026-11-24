SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- An effect's Graphile job is keyed by the ledger key's SHA-256, since Graphile
-- caps a job key at 512 bytes and a key may carry a deck's every card (mecha's
-- reentry.ts jobKeySql). The deck's generation has enqueued so since
-- 20261028_bounded_effect_jobs; the card art's trigger, which 20261105
-- re-created raw, takes the same wrap, and the order's machine is restated as
-- the emitter spells it now, its timer stamped for timer-check.
DO $migration$
DECLARE source text;
BEGIN
  IF to_regprocedure('airlock.snapcards_enqueue_job(text,json,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'bounded effect enqueue is missing';
  END IF;
  source := pg_get_functiondef('public.trg_card_art_status_machine()'::regprocedure);
  IF position('graphile_worker.add_job(' in source) = 0 THEN
    RAISE EXCEPTION 'card art trigger has no effect enqueue call';
  END IF;
  EXECUTE replace(source, 'graphile_worker.add_job(', 'airlock.snapcards_enqueue_job(');
END
$migration$;

ALTER TABLE "print_order" DROP CONSTRAINT IF EXISTS "print_order_status_check";
ALTER TABLE "print_order" ADD CONSTRAINT "print_order_status_check" CHECK ("status" IN ('draft', 'quoting', 'converting', 'quote_failed', 'quoted', 'opening', 'open_failed', 'awaiting_payment', 'checking', 'unpaid', 'placing', 'recording', 'placed', 'vendor_checking', 'alerting', 'attention')) NOT VALID;

CREATE OR REPLACE FUNCTION "trg_print_order_status_machine"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
SET TimeZone = 'UTC'
SET DateStyle = 'ISO, YMD' AS $$
DECLARE
  outcome jsonb;
  timer_delay text;
  timer_branch integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('quoting', 'converting', 'opening', 'checking', 'placing', 'recording', 'vendor_checking', 'alerting') THEN
      RAISE EXCEPTION '% in % awaits an outcome and is not deleted', 'print_order', OLD."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
  SELECT t.delay, t.branch INTO timer_delay, timer_branch
    FROM public.machine_timer_tick t JOIN public.schedule s ON s.name = t.schedule
    WHERE t.transaction_id = pg_current_xact_id() AND t.branch IS NOT NULL
      AND t.machine = 'PrintOrderMachine'
      AND t."row" = jsonb_build_object('id', OLD."id"::text)
      AND t.state = OLD."status";
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'quoting' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in quoting keeps its key until the outcome of %', 'print_order', 'print-quote:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'converting' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in converting keeps its key until the outcome of %', 'print_order', 'print-fx:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'opening' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in opening keeps its key until the outcome of %', 'print_order', 'print-session:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'checking' AND (OLD."checks" IS DISTINCT FROM NEW."checks" OR OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in checking keeps its key until the outcome of %', 'print_order', 'print-check:' || jsonb_build_array(OLD."id"::text, OLD."checks"::text)::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'placing' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in placing keeps its key until the outcome of %', 'print_order', 'print-place:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'recording' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in recording keeps its key until the outcome of %', 'print_order', 'print-record:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'vendor_checking' AND (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."vendor_checks" IS DISTINCT FROM NEW."vendor_checks") THEN
    RAISE EXCEPTION '% in vendor_checking keeps its key until the outcome of %', 'print_order', 'print-status:' || jsonb_build_array(OLD."id"::text, OLD."vendor_checks"::text)::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'alerting' AND (OLD."id" IS DISTINCT FROM NEW."id") THEN
    RAISE EXCEPTION '% in alerting keeps its key until the outcome of %', 'print_order', 'print-alert:' || OLD."id"::text USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = NEW."status" AND timer_delay IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' THEN
      RAISE EXCEPTION 'new % must start in initial state % (got %)', 'print_order', 'draft', NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'draft' THEN



      IF NEW."status" = 'quoting' AND timer_delay IS NULL THEN
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-quote:' || NEW."id"::text, 'print-quote', jsonb_build_object('id', NEW."id"), jsonb_build_object('stock', NEW."stock", 'cards', NEW."cards", 'country', NEW."country", 'currency', 'usd'))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering quoting again needs a new key', 'print-quote:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-quote:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-quote:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'quoting' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-quote:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves quoting only by the recorded outcome of %', 'print_order', 'print-quote:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'converting' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'converting';
        NEW."cost" := (outcome->'data'->>'cost')::int;
        NEW."cost_shipping" := (outcome->'data'->>'shipping')::int;
        NEW."currency" := CASE NEW.country WHEN 'BR' THEN 'brl' WHEN 'AR' THEN 'ars' WHEN 'IL' THEN 'ils' WHEN 'US' THEN 'usd' WHEN 'GB' THEN 'gbp' WHEN 'CN' THEN 'cny' END;
        NEW."sku" := outcome->'data'->>'sku';
        NEW."shipping_method" := outcome->'data'->>'shipping_method';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-fx:' || NEW."id"::text, 'print-fx', jsonb_build_object('id', NEW."id"), jsonb_build_object('cost', NEW."cost", 'shipping', NEW."cost_shipping", 'currency', NEW."currency", 'markup_percent', 80))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering converting again needs a new key', 'print-fx:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-fx:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-fx:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      IF NEW."status" = 'quote_failed' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'quote_failed';
        NEW."failure" := (outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '');
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'converting' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-fx:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves converting only by the recorded outcome of %', 'print_order', 'print-fx:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'quoted' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'quoted';
        NEW."item" := (outcome->'data'->>'item')::int;
        NEW."shipping" := (outcome->'data'->>'shipping')::int;
        NEW."total" := (outcome->'data'->>'total')::int;
        NEW."fx_quote" := outcome->'data'->>'quote';
        NEW."fx_rates" := (outcome->'data'->'rates')::json;
        NEW."fx_brl" := (outcome->'data'->>'brl')::int;
        RETURN NEW;
      END IF;
      IF NEW."status" = 'quote_failed' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'quote_failed';
        NEW."failure" := (outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '');
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'quote_failed' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'print_order' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'quoted' THEN



      IF NEW."status" = 'opening' AND timer_delay IS NULL THEN
        NEW."opened_at" := now();
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-session:' || NEW."id"::text, 'print-session', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'total', NEW."total", 'currency', NEW."currency", 'title', NEW."title", 'artwork', NEW."artwork", 'email', NULLIF(NEW.delivery->'contact'->>'email', ''), 'opened_epoch', extract(epoch from COALESCE(NEW.opened_at, NEW.created_at))::bigint))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering opening again needs a new key', 'print-session:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-session:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-session:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'opening' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-session:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves opening only by the recorded outcome of %', 'print_order', 'print-session:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'awaiting_payment' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'awaiting_payment';
        NEW."session_id" := outcome->'data'->>'id';
        NEW."checkout_url" := outcome->'data'->>'url';
        NEW."print_file" := substring(outcome->'data'->>'file' from 'mecha-objects/(.+)$');
        RETURN NEW;
      END IF;
      IF NEW."status" = 'open_failed' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'open_failed';
        NEW."failure" := (outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '');
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'open_failed' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'print_order' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'awaiting_payment' THEN



      IF NEW."status" = 'checking' AND timer_delay IS NULL THEN
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text, 'print-check', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'session_id', NEW."session_id", 'total', NEW."total", 'currency', NEW."currency", 'live', false))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering checking again needs a new key', 'print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text), job_key => encode(sha256(convert_to('print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      IF NEW."status" = 'checking' AND timer_delay = '600000' AND timer_branch = 0 THEN
        NEW."checks" := OLD.checks + 1;
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text, 'print-check', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'session_id', NEW."session_id", 'total', NEW."total", 'currency', NEW."currency", 'live', false))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering checking again needs a new key', 'print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text), job_key => encode(sha256(convert_to('print-check:' || jsonb_build_array(NEW."id"::text, NEW."checks"::text)::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'checking' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-check:' || jsonb_build_array(OLD."id"::text, OLD."checks"::text)::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves checking only by the recorded outcome of %', 'print_order', 'print-check:' || jsonb_build_array(OLD."id"::text, OLD."checks"::text)::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'placing' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'placing';
        NEW."paid_at" := now();
        NEW."payment_state" := 'paid';
        NEW."payment_intent" := outcome->'data'->>'payment_intent';
        NEW."customer_email" := outcome->'data'->>'email';
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-place:' || NEW."id"::text, 'print-place', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'artwork', NEW."artwork", 'delivery', NEW."delivery", 'sku', NEW."sku", 'shipping_method', NEW."shipping_method", 'email', NEW."customer_email"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering placing again needs a new key', 'print-place:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-place:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-place:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      IF NEW."status" = 'awaiting_payment' AND outcome->>'kind' <> 'done' AND (outcome->'data'->>'state' IN ('expired', 'failed')) IS TRUE THEN

        NEW."status" := 'unpaid';
        NEW."payment_state" := outcome->'data'->>'state';
        RETURN NEW;
      END IF;
      IF NEW."status" = 'awaiting_payment' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'awaiting_payment';
        NEW."payment_state" := COALESCE(outcome->'data'->>'state', outcome->>'kind');
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'unpaid' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'print_order' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'placing' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-place:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves placing only by the recorded outcome of %', 'print_order', 'print-place:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'recording' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'recording';
        NEW."vendor_order_id" := outcome->'data'->>'id';
        NEW."vendor_state" := CASE outcome->'data'->>'stage' WHEN 'OnHold' THEN 'on_hold' ELSE 'in_progress' END;
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-record:' || NEW."id"::text, 'print-record', jsonb_build_object('id', NEW."id"), jsonb_build_object('sku', NEW."sku", 'cost', NEW."cost", 'fx_quote', NEW."fx_quote", 'fx_brl', NEW."fx_brl", 'vendor_order_id', NEW."vendor_order_id", 'from', 'snapcards@snapcards.fun', 'to', 'davi@davi.eng.br', 'live', false, 'id', NEW."id", 'title', NEW."title", 'stock', NEW."stock", 'cards', NEW."cards", 'total', NEW."total", 'currency', NEW."currency", 'email', NEW."customer_email", 'delivery', NEW."delivery", 'print_file', NEW."print_file"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering recording again needs a new key', 'print-record:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-record:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-record:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      IF NEW."status" = 'alerting' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'alerting';
        NEW."failure" := (outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '');
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-alert:' || NEW."id"::text, 'print-alert', jsonb_build_object('id', NEW."id"), jsonb_build_object('failure', NEW."failure", 'from', 'snapcards@snapcards.fun', 'to', 'davi@davi.eng.br', 'live', false, 'id', NEW."id", 'title', NEW."title", 'stock', NEW."stock", 'cards', NEW."cards", 'total', NEW."total", 'currency', NEW."currency", 'email', NEW."customer_email", 'delivery', NEW."delivery", 'print_file', NEW."print_file"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering alerting again needs a new key', 'print-alert:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-alert:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-alert:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 45);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'recording' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-record:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves recording only by the recorded outcome of %', 'print_order', 'print-record:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'placed' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'placed';

        RETURN NEW;
      END IF;
      IF NEW."status" = 'placed' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'placed';

        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'placed' THEN



      IF NEW."status" = 'vendor_checking' AND timer_delay IS NULL THEN
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-status:' || jsonb_build_array(NEW."id"::text, NEW."vendor_checks"::text)::text, 'print-status', jsonb_build_object('id', NEW."id"), jsonb_build_object('id', NEW."id", 'vendor_order_id', NEW."vendor_order_id"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering vendor_checking again needs a new key', 'print-status:' || jsonb_build_array(NEW."id"::text, NEW."vendor_checks"::text)::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-status:' || jsonb_build_array(NEW."id"::text, NEW."vendor_checks"::text)::text), job_key => encode(sha256(convert_to('print-status:' || jsonb_build_array(NEW."id"::text, NEW."vendor_checks"::text)::text, 'UTF8')), 'hex'), max_attempts => 30);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'vendor_checking' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-status:' || jsonb_build_array(OLD."id"::text, OLD."vendor_checks"::text)::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves vendor_checking only by the recorded outcome of %', 'print_order', 'print-status:' || jsonb_build_array(OLD."id"::text, OLD."vendor_checks"::text)::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'placed' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'placed';
        NEW."vendor_state" := outcome->'data'->>'state';
        RETURN NEW;
      END IF;
      IF NEW."status" = 'alerting' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'alerting';
        NEW."failure" := (outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '');
        INSERT INTO "airlock"."external_effect_ledger" ("key", "effect", "row", "input")
        VALUES ('print-alert:' || NEW."id"::text, 'print-alert', jsonb_build_object('id', NEW."id"), jsonb_build_object('failure', NEW."failure", 'from', 'snapcards@snapcards.fun', 'to', 'davi@davi.eng.br', 'live', false, 'id', NEW."id", 'title', NEW."title", 'stock', NEW."stock", 'cards', NEW."cards", 'total', NEW."total", 'currency', NEW."currency", 'email', NEW."customer_email", 'delivery', NEW."delivery", 'print_file', NEW."print_file"))
        ON CONFLICT ("key") DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'external effect % was already performed: entering alerting again needs a new key', 'print-alert:' || NEW."id"::text USING ERRCODE = 'unique_violation';
        END IF;
        PERFORM graphile_worker.add_job('external_effect', json_build_object('key', 'print-alert:' || NEW."id"::text), job_key => encode(sha256(convert_to('print-alert:' || NEW."id"::text, 'UTF8')), 'hex'), max_attempts => 45);
        UPDATE "public"."schedule" SET "due_at" = date_trunc('milliseconds', clock_timestamp()), "last_tick_at" = NULL
         WHERE "name" = 'airlock' AND "last_tick_at" IS NOT NULL
           AND "name" IN (SELECT "name" FROM "public"."schedule" WHERE "name" = 'airlock' FOR UPDATE SKIP LOCKED);
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'alerting' THEN
      SELECT l."outcome" INTO outcome FROM "airlock"."external_effect_ledger" l WHERE l."key" = 'print-alert:' || OLD."id"::text;
      IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW."status" THEN
        RAISE EXCEPTION '% leaves alerting only by the recorded outcome of %', 'print_order', 'print-alert:' || OLD."id"::text USING ERRCODE = 'check_violation';
      END IF;

      IF NEW."status" = 'attention' AND outcome->>'kind' = 'done' THEN

        NEW."status" := 'attention';

        RETURN NEW;
      END IF;
      IF NEW."status" = 'attention' AND outcome->>'kind' <> 'done' THEN

        NEW."status" := 'attention';

        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'invalid transition on % from % to %', 'print_order', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'attention' THEN
      RAISE EXCEPTION 'cannot transition from final state % on %', OLD."status", 'print_order' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "trg_print_order_status_machine" ON "print_order";
CREATE TRIGGER "trg_print_order_status_machine"
  BEFORE INSERT OR UPDATE OR DELETE ON "print_order"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_print_order_status_machine"();

DO $$ BEGIN
  PERFORM set_config('TimeZone', 'UTC', true);
  PERFORM set_config('DateStyle', 'ISO, YMD', true);
  IF to_regprocedure('"trg_print_order_status_timer_arm"()') IS NULL THEN
  IF EXISTS (SELECT FROM "print_order" r WHERE r."status" = 'awaiting_payment'
    AND NOT EXISTS (SELECT FROM public.schedule s WHERE s.emits_entity = 'machine_timer_tick'
      AND s.due_at IS NOT NULL AND NOT s.suspended AND s.last_tick_at IS NULL
      AND s.emits_values = jsonb_build_object('machine', 'PrintOrderMachine', 'row', jsonb_build_object('id', r."id"::text), 'state', 'awaiting_payment', 'delay', '600000'))) THEN
    RAISE EXCEPTION 'machine PrintOrderMachine requires explicit state-entry deadlines for existing rows before timer adoption';
  END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "trg_print_order_status_timer_guard"(OLD "print_order", NEW "print_order", delay text, branch integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  TG_OP constant text := 'UPDATE';
  TG_TABLE_NAME constant text := 'print_order';
BEGIN
IF OLD."status" = 'awaiting_payment' AND delay = '600000' AND branch = 0 THEN RETURN (COALESCE(OLD.opened_at, OLD.created_at) > now() - interval '27 hours') IS TRUE; END IF;
  RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION "trg_print_order_status_timer_guard"("print_order", "print_order", text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "trg_print_order_status_timer_arm"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE
  timer_delay text;
  timer_branch integer;
  entered_at timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
  -- A nested AFTER write cannot silently replace the visit being armed.
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT FROM "print_order" r WHERE r."id" = OLD."id") THEN
      RAISE EXCEPTION 'timer owner print_order was recreated by an earlier AFTER trigger';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT FROM "print_order" r WHERE r."id" = NEW."id" AND r.ctid = NEW.ctid) THEN
      RAISE EXCEPTION 'timer owner print_order changed again in an earlier AFTER trigger';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    DELETE FROM public.schedule WHERE emits_entity = 'machine_timer_tick' AND emits_values @> jsonb_build_object('machine', 'PrintOrderMachine', 'row', jsonb_build_object('id', NEW."id"::text));
  END IF;
  IF TG_OP = 'UPDATE' THEN
  SELECT t.delay, t.branch INTO timer_delay, timer_branch
    FROM public.machine_timer_tick t JOIN public.schedule s ON s.name = t.schedule
    WHERE t.transaction_id = pg_current_xact_id() AND t.branch IS NOT NULL
      AND t.machine = 'PrintOrderMachine'
      AND t."row" = jsonb_build_object('id', OLD."id"::text)
      AND t.state = OLD."status";
    IF OLD."status" IS NOT DISTINCT FROM NEW."status" AND (OLD."id" IS NOT DISTINCT FROM NEW."id") AND timer_delay IS NULL THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM public.schedule WHERE emits_entity = 'machine_timer_tick' AND emits_values @> jsonb_build_object('machine', 'PrintOrderMachine', 'row', jsonb_build_object('id', OLD."id"::text));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW."status" = 'awaiting_payment' THEN
    INSERT INTO public.schedule (name, due_at, max_lateness_seconds, emits_entity, emits_values)
      VALUES ('machine:' || gen_random_uuid()::text, entered_at + interval '600000 milliseconds',
        2147483647, 'machine_timer_tick', jsonb_build_object('machine', 'PrintOrderMachine', 'row', jsonb_build_object('id', NEW."id"::text), 'state', 'awaiting_payment', 'delay', '600000'));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "trg_print_order_status_timer_arm"() FROM PUBLIC;
DROP TRIGGER IF EXISTS "trg_print_order_status_timer_arm" ON "print_order";
CREATE TRIGGER "trg_print_order_status_timer_arm" AFTER INSERT OR UPDATE OR DELETE ON "print_order"
  FOR EACH ROW EXECUTE FUNCTION "trg_print_order_status_timer_arm"();

CREATE OR REPLACE FUNCTION "trg_print_order_status_timer_fire"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
SET TimeZone = 'UTC' SET DateStyle = 'ISO, YMD' AS $$
DECLARE held "print_order"; proposed "print_order";
BEGIN
  IF NEW.machine <> 'PrintOrderMachine' OR NEW.late THEN RETURN NEW; END IF;
  SELECT r.* INTO held FROM "print_order" r WHERE r."id" = (jsonb_populate_record(NULL::"print_order", NEW."row"))."id" FOR UPDATE;
  IF NOT FOUND OR held."status" IS DISTINCT FROM NEW.state THEN RETURN NEW; END IF;
  -- Lock the owner before rechecking cancellation, as transitions do.
  PERFORM 1 FROM public.schedule s WHERE s.name = NEW.schedule AND s.emits_entity = 'machine_timer_tick'
    AND s.due_at = NEW.tick_at AND s.due_at <= clock_timestamp()
    AND s.emits_values = jsonb_build_object('machine', NEW.machine, 'row', NEW."row", 'state', NEW.state, 'delay', NEW.delay);
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.state = 'awaiting_payment' AND NEW.delay = '600000' THEN
    proposed := held;
    proposed."status" := 'checking';
    IF "trg_print_order_status_timer_guard"(held, proposed, NEW.delay, 0) THEN
      UPDATE public.machine_timer_tick SET branch = 0 WHERE id = NEW.id;
      UPDATE "print_order" r SET "status" = proposed."status" WHERE r."id" = held."id";
      DELETE FROM public.schedule WHERE name = NEW.schedule;
      RETURN NEW;
    END IF;
  END IF;
  DELETE FROM public.schedule WHERE name = NEW.schedule;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "trg_print_order_status_timer_fire"() FROM PUBLIC;
DROP TRIGGER IF EXISTS "trg_print_order_status_timer_fire" ON public.machine_timer_tick;
CREATE TRIGGER "trg_print_order_status_timer_fire" AFTER INSERT ON public.machine_timer_tick
  FOR EACH ROW EXECUTE FUNCTION "trg_print_order_status_timer_fire"();
COMMENT ON FUNCTION "trg_print_order_status_timer_arm"() IS '02083c824df177ad72d9790ee4a47fc3900fc2662cf5d9ae010dc69e8a437b2b';
