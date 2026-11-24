SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A deck's cover beside its count, so a library card reads one row: the
-- deck's first card's art, as the card read with limit=1 showed it.
ALTER TABLE deck_stats ADD COLUMN IF NOT EXISTS "cover" text NOT NULL DEFAULT '';
-- A cover arrives before any favourite: its row starts the count at zero.
-- Setting a default twice sets the same default, so a rerun is harmless.
-- squawk-ignore prefer-robust-stmts
ALTER TABLE deck_stats ALTER COLUMN "favorite_count" SET DEFAULT 0;
-- squawk-ignore prefer-robust-stmts
ALTER TABLE deck_stats ALTER COLUMN "counted_txid" SET DEFAULT 0;

-- The cover drain: on the edge, where no pipeline runs, it keeps what the
-- deck-cover pipeline keeps in a container. It writes only where a cover moved.
CREATE OR REPLACE FUNCTION refresh_deck_covers() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO deck_stats (deck_id, cover)
  SELECT DISTINCT ON (f.set_id) f.set_id::text, coalesce(f.back, '')
  FROM flashcard f
  ORDER BY f.set_id, f.id
  ON CONFLICT (deck_id) DO UPDATE SET cover = EXCLUDED.cover
  WHERE deck_stats.cover IS DISTINCT FROM EXCLUDED.cover;
END $$;

REVOKE ALL ON FUNCTION refresh_deck_covers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_deck_covers() TO service;

SELECT refresh_deck_covers();
