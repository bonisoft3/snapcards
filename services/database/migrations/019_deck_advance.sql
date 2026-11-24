SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- The deck-advance hatch: each device's two text slots, "<device>:draft-cheap"
-- and "<device>:draft-heavy", take that device's next deck owed its level. A
-- deck names its device (card_set.device), so one device's decks never wait on,
-- or write, another's slots. The cheap slot takes a deck once every card of it
-- reached the server and no level-2 art of its newest run exists; the heavy slot
-- takes a deck with level-2 art of its newest run and no level-3 art of that
-- run; the newest deck goes first. A slot still running, or holding a
-- translation its tab has not read, is not free; the slot's own settlement and
-- the deck-level drain call this again, and every call reads the rows whole, so
-- none starts a level twice. A slot the database lost under a device that still
-- holds its key is put back idle before it is asked.
CREATE OR REPLACE FUNCTION snapcards_advance_decks() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE
  v_deck record;
  v_region text;
BEGIN
  FOR v_deck IN
    SELECT DISTINCT ON (s.device) s.id, s.device, s.name, s.details, s.locale, s.region, c.cards, c.run
    FROM card_set s
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS cards,
             max((regexp_match(f.hint, '(?:^|\|)run-([0-9]+)(?:\||$)'))[1]::integer) AS run
      FROM flashcard f WHERE f.set_id = s.id
    ) c
    WHERE s.device <> '' AND s.cover_emoji = '🎨'
      AND c.cards > 0 AND c.cards = s.count AND c.run IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM card_art a WHERE a.set_id = s.id AND a.level = 2 AND a.run = 'run-' || c.run)
    ORDER BY s.device, s.category DESC, s.id
  LOOP
    v_region := CASE WHEN v_deck.region = '' THEN 'run-' || v_deck.run ELSE v_deck.region || ' :: run-' || v_deck.run END;
    PERFORM snapcards_slot(v_deck.device || ':draft-cheap', v_deck.locale);
    UPDATE generation_draft SET status = 'drafting', topic = v_deck.name, details = v_deck.details, set_id = v_deck.id,
        category = '', locale = v_deck.locale, card_count = v_deck.cards, region = v_region
      WHERE id = v_deck.device || ':draft-cheap' AND status <> 'drafting'
        AND NOT (status = 'done' AND topic LIKE '% :: [TRANSLATE:%')
        AND (set_id, region) IS DISTINCT FROM (v_deck.id, v_region);
  END LOOP;

  FOR v_deck IN
    SELECT DISTINCT ON (s.device) s.id, s.device, s.name, s.details, s.locale, s.region, c.cards, l.run
    FROM card_set s
    CROSS JOIN LATERAL (
      SELECT max(substring(a.run FROM 5)::integer) AS run FROM card_art a WHERE a.set_id = s.id AND a.level = 2
    ) l
    CROSS JOIN LATERAL (SELECT count(*)::integer AS cards FROM flashcard f WHERE f.set_id = s.id) c
    WHERE s.device <> '' AND l.run IS NOT NULL AND c.cards > 0
      AND NOT EXISTS (SELECT 1 FROM card_art a WHERE a.set_id = s.id AND a.level = 3 AND a.run = 'run-' || l.run)
    ORDER BY s.device, s.category DESC, s.id
  LOOP
    v_region := CASE WHEN v_deck.region = '' THEN 'run-' || v_deck.run ELSE v_deck.region || ' :: run-' || v_deck.run END;
    PERFORM snapcards_slot(v_deck.device || ':draft-heavy', v_deck.locale);
    UPDATE generation_draft SET status = 'illustrating', topic = v_deck.name, details = v_deck.details, set_id = v_deck.id,
        category = '', locale = v_deck.locale, card_count = v_deck.cards, region = v_region
      WHERE id = v_deck.device || ':draft-heavy' AND status <> 'illustrating'
        AND (set_id, region) IS DISTINCT FROM (v_deck.id, v_region);
  END LOOP;
END $$;

-- A slot as the device's tab puts it when it mints its key: idle, naming nothing.
CREATE OR REPLACE FUNCTION snapcards_slot(slot text, locale text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  INSERT INTO generation_draft (id, topic, category, locale, region, card_count, status, set_id, details)
    VALUES (slot, '', '', locale, '', 0, 'idle', '', '')
    ON CONFLICT (id) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION snapcards_slot(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION snapcards_advance_decks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION snapcards_advance_decks() TO service;
