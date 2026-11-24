SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- The deck-level drain: each deck's counts per level, recomputed whole from
-- card_art over the cards that still exist, written only where they moved.
-- A level whose rows all settled moves on its own statement, so the deck's
-- settlement (DeckLevelMachine) reads every other level's status as it is.
-- Settled art of a deleted card goes; its deletion wakes the drain once more,
-- and that call writes nothing. A change to cards or art may owe a deck its
-- next text level (019_deck_advance.sql).
-- Each deck with cards and the newest run its cards' hints name.
CREATE OR REPLACE FUNCTION snapcards_newest_runs() RETURNS TABLE (set_id text, run text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT f.set_id, 'run-' || max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer)
  FROM flashcard f GROUP BY f.set_id
  HAVING max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION snapcards_newest_runs() FROM PUBLIC;

CREATE OR REPLACE FUNCTION snapcards_count_art() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_level record;
BEGIN
  INSERT INTO deck_level (id, set_id, level, run, total, drawn, failed, unknown, pending, status)
  SELECT a.set_id || ':' || a.level, a.set_id, a.level,
         (array_agg(a.run ORDER BY substring(a.run FROM 5)::integer DESC))[1], count(*)::integer,
         (count(*) FILTER (WHERE a.status = 'drawn'))::integer,
         (count(*) FILTER (WHERE a.status = 'failed'))::integer,
         (count(*) FILTER (WHERE a.status = 'unknown'))::integer,
         (count(*) FILTER (WHERE a.status IN ('waiting', 'pending')))::integer,
         'running'
  FROM card_art a JOIN flashcard f ON f.id = a.card_id
  GROUP BY a.set_id, a.level
  ON CONFLICT (id) DO UPDATE SET run = EXCLUDED.run, total = EXCLUDED.total, drawn = EXCLUDED.drawn, failed = EXCLUDED.failed,
    unknown = EXCLUDED.unknown, pending = EXCLUDED.pending,
    status = CASE WHEN EXCLUDED.pending > 0 THEN 'running' ELSE deck_level.status END
  WHERE (deck_level.run, deck_level.total, deck_level.drawn, deck_level.failed, deck_level.unknown, deck_level.pending)
    IS DISTINCT FROM (EXCLUDED.run, EXCLUDED.total, EXCLUDED.drawn, EXCLUDED.failed, EXCLUDED.unknown, EXCLUDED.pending);

  DELETE FROM deck_level d WHERE NOT EXISTS (
    SELECT 1 FROM card_art a JOIN flashcard f ON f.id = a.card_id WHERE a.set_id = d.set_id AND a.level = d.level);

  FOR v_level IN SELECT id FROM deck_level WHERE status = 'running' AND pending = 0 ORDER BY set_id, level LOOP
    UPDATE deck_level SET status = CASE WHEN drawn = total THEN 'complete' WHEN drawn = 0 THEN 'failed' ELSE 'partial' END
      WHERE id = v_level.id;
  END LOOP;

  DELETE FROM card_art a WHERE a.status <> 'pending' AND NOT EXISTS (SELECT 1 FROM flashcard f WHERE f.id = a.card_id);

  -- Each deck's progress (DeckProgressMachine) over its newest run: from the run's
  -- two levels, which states the machine moves the row to; a move it refuses
  -- fails the drain, which retries. A deck generated again starts over at
  -- drafting, and a deck gone takes its progress with it.
  INSERT INTO deck_progress (id, run, status)
  SELECT n.set_id, n.run, 'drafting' FROM snapcards_newest_runs() n
  ON CONFLICT (id) DO NOTHING;
  UPDATE deck_progress p SET status = 'drafting', run = n.run
    FROM snapcards_newest_runs() n WHERE n.set_id = p.id AND n.run <> p.run;
  UPDATE deck_progress p SET status = t.status
    FROM (
      SELECT n.set_id,
             CASE
               WHEN l2.status IS NULL THEN 'drafting'
               WHEN l2.status = 'running' AND l3.status IS NULL THEN 'drawing2'
               WHEN l2.status = 'running' THEN 'drawing23'
               WHEN l3.status IS NULL THEN 'drawn2_' || l2.status
               WHEN l3.status = 'running' THEN 'drawing3_' || l2.status
               WHEN l2.status = 'complete' AND l3.status = 'complete' THEN 'done'
               WHEN l2.status = 'failed' AND l3.status = 'failed' THEN 'failed'
               ELSE 'partial'
             END AS status
      FROM snapcards_newest_runs() n
      LEFT JOIN deck_level l2 ON l2.set_id = n.set_id AND l2.level = 2 AND l2.run = n.run
      LEFT JOIN deck_level l3 ON l3.set_id = n.set_id AND l3.level = 3 AND l3.run = n.run
    ) t
    WHERE t.set_id = p.id AND t.status <> p.status;
  DELETE FROM deck_progress p WHERE NOT EXISTS (SELECT 1 FROM card_set s WHERE s.id = p.id);

  PERFORM snapcards_advance_decks();
END $$;

REVOKE ALL ON FUNCTION snapcards_count_art() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION snapcards_count_art() TO service;
