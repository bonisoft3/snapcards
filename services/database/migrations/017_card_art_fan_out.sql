SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- A text level's outcome, from GenerationMachine's trigger: the deck's cards,
-- in position order, take the level's words in order and one card_art row
-- each. A row starts at once at level 2 and, at level 3, once its own card's
-- level 2 has settled; a card the text named no word for, or a refused text,
-- leaves its row failed. The cards are the deck's rows, not the text's
-- count, since a reader may delete a card between the two levels.
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
      VALUES (v_art_id, v_card_id, deck, v_run, art_level, v_deck_card.position, 'waiting', '')
      ON CONFLICT (id) DO UPDATE SET run = EXCLUDED.run,
        position = EXCLUDED.position, status = 'waiting', detail = '', description = ''
      WHERE card_art.status <> 'pending' AND card_art.run <> EXCLUDED.run;
    IF v_word IS NULL THEN
      UPDATE card_art SET status = 'failed', detail = COALESCE(v_refusal, 'the text named no word for this card')
        WHERE id = v_art_id AND status = 'waiting';
    ELSE
      UPDATE card_art a SET status = 'pending'
        WHERE a.id = v_art_id AND a.status = 'waiting'
          AND NOT EXISTS (SELECT 1 FROM card_art s WHERE s.card_id = v_card_id AND s.level = art_level - 1
                            AND s.status IN ('waiting', 'pending'));
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION snapcards_fan_out_art(text, text, integer, jsonb) FROM PUBLIC;
