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
