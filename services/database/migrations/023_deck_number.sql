-- A deck's number among its owner's decks, for display ("#3"): assigned here on
-- insert, never by a browser, since two tabs creating at once would count the
-- same decks. A deck's key is its UUID; the number keys nothing, so nothing
-- enforces it. A deck with no owner (curated, imported) has none.
--
-- Idempotent via CREATE OR REPLACE and DROP ... IF EXISTS.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

CREATE OR REPLACE FUNCTION snapcards_number_deck() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.owner IS NULL THEN
    NEW.number := 0;
    RETURN NEW;
  END IF;
  -- One owner's inserts take their numbers one at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('card_set.number:' || NEW.owner::text, 0));
  SELECT COALESCE(max(s.number), 0) + 1 INTO NEW.number FROM card_set s WHERE s.owner = NEW.owner;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION snapcards_number_deck() FROM PUBLIC;

DROP TRIGGER IF EXISTS card_set_number ON card_set;
CREATE TRIGGER card_set_number BEFORE INSERT ON card_set
  FOR EACH ROW EXECUTE FUNCTION snapcards_number_deck();

COMMIT;
