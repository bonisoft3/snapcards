SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $protocol$ BEGIN
  IF to_regnamespace('hybrid_deck_press') IS NOT NULL AND obj_description(to_regnamespace('hybrid_deck_press'), 'pg_namespace') IS DISTINCT FROM 'Hybrid deck_press protocol 1; no public canonical-state access' THEN
    RAISE EXCEPTION 'hybrid_deck_press holds instances of another protocol than 1' USING ERRCODE = '55000';
  END IF;
END $protocol$;

DO $isolation$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN ALTER ROLE app_user RESET default_transaction_isolation; ALTER ROLE app_user RESET enable_seqscan; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service') THEN ALTER ROLE service RESET default_transaction_isolation; ALTER ROLE service RESET enable_seqscan; END IF;
END $isolation$;

-- pgroll applies this index inside its transaction; both waits are bounded.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS member_actor ON hybrid_deck_press.member (actor);

CREATE OR REPLACE FUNCTION hybrid_deck_press.serial() RETURNS void LANGUAGE plpgsql AS $serial$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a deck_press step runs read committed, not %', current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;
END;
$serial$;

CREATE OR REPLACE FUNCTION hybrid_deck_press.hold(actors uuid[]) RETURNS void LANGUAGE plpgsql AS $hold$
DECLARE k integer;
BEGIN
  FOR k IN SELECT DISTINCT hashtext(a::text) FROM unnest(actors) a WHERE a IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtext('mecha player'), k);
  END LOOP;
END;
$hold$;

REVOKE ALL ON FUNCTION hybrid_deck_press.hold(uuid[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hybrid_deck_press.hold_instance(room uuid, joining uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $hold_instance$
BEGIN
  PERFORM hybrid_deck_press.hold(ARRAY(SELECT m.actor FROM hybrid_deck_press.member m WHERE m.instance_id = room) || joining);
END;
$hold_instance$;

REVOKE ALL ON FUNCTION hybrid_deck_press.hold_instance(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hybrid_deck_press.dispatch(instance_id uuid, actor uuid, command_id text, request jsonb, tier text, at bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, hybrid_deck_press
SET statement_timeout = '5s'
SET lock_timeout = '2s'
AS $dispatch$
DECLARE
  game hybrid_deck_press.instance;
  prior hybrid_deck_press.receipt;
  seat text;
  answer jsonb;
  reduced jsonb;
  recipients jsonb;
  now_ms bigint;
  drawn text;
  prepared_revision bigint;
BEGIN
  PERFORM hybrid_deck_press.serial();
  PERFORM hybrid_deck_press.hold_instance(instance_id);
  
  SELECT * INTO STRICT game FROM hybrid_deck_press.instance i WHERE i.id = instance_id FOR UPDATE;
  IF tier = 'omnishell' THEN
    SELECT m.seat INTO seat FROM hybrid_deck_press.member m WHERE m.instance_id = game.id AND m.actor = dispatch.actor;
    IF seat IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
  ELSIF tier <> 'mecha' THEN
    RAISE EXCEPTION 'invalid tier';
  END IF;
  now_ms := coalesce(at, hybrid_deck_press.clock());
  SELECT * INTO prior FROM hybrid_deck_press.receipt r WHERE r.instance_id = game.id AND r.actor = dispatch.actor AND r.command_id = dispatch.command_id;
  IF FOUND THEN
    IF prior.request <> request THEN RAISE EXCEPTION 'command id reused with different input' USING ERRCODE = '22023'; END IF;
    RETURN prior.result;
  END IF;
  IF request->>'version' IS DISTINCT FROM game.version::text THEN
    answer := jsonb_build_object('kind', 'rejected', 'reason', 'protocol_version');
  ELSIF request->>'expected_revision' IS DISTINCT FROM game.revision::text THEN
    answer := jsonb_build_object('kind', 'rejected', 'reason', 'stale_revision');
  ELSE
    
    SELECT coalesce(jsonb_agg(m.seat ORDER BY m.seat), '[]'::jsonb) INTO recipients FROM hybrid_deck_press.member m WHERE m.instance_id = game.id;
    reduced := hybrid_deck_press.step(jsonb_build_object(
      'state', game.state,
      'event', request->'event',
      'context', jsonb_build_object('actor', seat, 'tier', tier, 'now', now_ms),
      'viewers', recipients
    ));
    IF reduced->>'kind' = 'accepted' THEN
      
    END IF;
    IF reduced->>'kind' = 'accepted' THEN
      UPDATE hybrid_deck_press.instance i SET state = reduced->'state', revision = i.revision + 1 WHERE i.id = game.id
        RETURNING i.* INTO STRICT game;
      PERFORM hybrid_deck_press.settle(game, reduced);
      answer := jsonb_build_object('kind', 'accepted');
    ELSIF reduced->>'kind' = 'rejected' THEN
      answer := reduced;
    ELSE
      RAISE EXCEPTION 'invalid hybrid result';
    END IF;
  END IF;
  answer := answer || jsonb_build_object('command_id', command_id, 'revision', game.revision::text);
  INSERT INTO hybrid_deck_press.receipt (instance_id, actor, command_id, request, result, now, entropy)
    VALUES (game.id, actor, command_id, request, answer, now_ms, drawn);
  RETURN answer;
END;
$dispatch$;

REVOKE ALL ON FUNCTION hybrid_deck_press.dispatch(uuid, uuid, text, jsonb, text, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hybrid_deck_press.deliver(instance_id uuid, event jsonb, at bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hybrid_deck_press AS $deliver$
DECLARE revision bigint; answer jsonb;
BEGIN
  -- Locked as dispatch will lock it, so the revision read is the one it checks.
  PERFORM hybrid_deck_press.hold_instance(instance_id);
  SELECT i.revision INTO STRICT revision FROM hybrid_deck_press.instance i WHERE i.id = instance_id FOR UPDATE;
  -- One delivery is accepted per revision, so the revision names it.
  answer := hybrid_deck_press.dispatch(instance_id, '00000000-0000-0000-0000-000000000000', 'mecha/' || revision::text,
    jsonb_build_object('version', 1, 'expected_revision', revision::text, 'event', event), 'mecha', at);
  IF answer->>'kind' IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'Mecha delivery refused: %', answer USING ERRCODE = 'check_violation';
  END IF;
END;
$deliver$;

REVOKE ALL ON FUNCTION hybrid_deck_press.deliver(uuid, jsonb, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hybrid_deck_press.spawn(instance_id uuid, input jsonb, participants jsonb, at bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $mecha_port$
DECLARE seeded jsonb;
BEGIN

IF instance_id IS NULL OR jsonb_typeof(participants) IS DISTINCT FROM 'object' OR participants = '{}'::jsonb THEN
 RAISE EXCEPTION 'initialization requires an identity and participants'; END IF;
PERFORM hybrid_deck_press.hold(ARRAY(SELECT value::uuid FROM jsonb_each_text(participants)));
seeded := hybrid_deck_press.step(jsonb_build_object('initialize', true, 'payload', input,
 'context', jsonb_build_object('tier', 'mecha', 'now', coalesce(at, hybrid_deck_press.clock())), 'viewers', '[]'::jsonb));
INSERT INTO hybrid_deck_press.instance (id, version, state) VALUES (instance_id, 1, seeded->'state');
INSERT INTO hybrid_deck_press.member (instance_id, actor, seat) SELECT instance_id, value::uuid, key FROM jsonb_each_text(participants);
PERFORM hybrid_deck_press.publish(instance_id);
END;
$mecha_port$;

REVOKE ALL ON FUNCTION hybrid_deck_press.spawn(uuid, jsonb, jsonb, bigint) FROM PUBLIC;
