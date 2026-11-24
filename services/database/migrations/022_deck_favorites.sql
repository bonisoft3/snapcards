SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- The favourite drain: on the edge, where no pipeline runs, it keeps what the
-- favorite-recount and favorite-count pipelines keep in a container. Each
-- statement writes only where its answer moved.
CREATE OR REPLACE FUNCTION refresh_deck_favorites() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  INSERT INTO deck_stats (deck_id, favorite_count, counted_txid)
  SELECT d.id, count(f.id) FILTER (WHERE f.deleted_at IS NULL)::integer, coalesce(max(f.txid), 0)
  FROM (SELECT deck_id AS id FROM favorite UNION SELECT deck_id FROM deck_stats) d
  LEFT JOIN favorite f ON f.deck_id = d.id
  GROUP BY d.id
  ON CONFLICT (deck_id) DO UPDATE SET
    favorite_count = EXCLUDED.favorite_count, counted_txid = EXCLUDED.counted_txid
  WHERE (deck_stats.favorite_count, deck_stats.counted_txid)
    IS DISTINCT FROM (EXCLUDED.favorite_count, EXCLUDED.counted_txid);

  INSERT INTO favorite_count (id, user_id, deck_id, mine_counted, total_at_read, as_of_txid)
  SELECT f.user_id::text || ':' || f.deck_id, f.user_id, f.deck_id,
         CASE WHEN f.deleted_at IS NULL THEN 1 ELSE 0 END,
         count(g.id) FILTER (WHERE g.deleted_at IS NULL)::integer, f.txid
  FROM favorite f JOIN favorite g ON g.deck_id = f.deck_id
  GROUP BY f.id, f.user_id, f.deck_id, f.deleted_at, f.txid
  ON CONFLICT (id) DO UPDATE SET mine_counted = EXCLUDED.mine_counted,
    total_at_read = EXCLUDED.total_at_read, as_of_txid = EXCLUDED.as_of_txid
  WHERE (favorite_count.mine_counted, favorite_count.total_at_read, favorite_count.as_of_txid)
    IS DISTINCT FROM (EXCLUDED.mine_counted, EXCLUDED.total_at_read, EXCLUDED.as_of_txid);

  -- A pair whose favourite went with its deck counts nobody.
  UPDATE favorite_count p SET mine_counted = 0,
    total_at_read = (SELECT count(*)::integer FROM favorite f WHERE f.deck_id = p.deck_id AND f.deleted_at IS NULL),
    as_of_txid = 0
  WHERE NOT EXISTS (SELECT 1 FROM favorite f WHERE f.user_id = p.user_id AND f.deck_id = p.deck_id)
    AND (p.mine_counted, p.total_at_read, p.as_of_txid) IS DISTINCT FROM
        (0, (SELECT count(*)::integer FROM favorite f WHERE f.deck_id = p.deck_id AND f.deleted_at IS NULL), 0::bigint);
END $$;

REVOKE ALL ON FUNCTION refresh_deck_favorites() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_deck_favorites() TO service;
