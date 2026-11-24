-- A deck's cards go with it, here rather than in the browser: a screen reads no
-- more of a deck's cards than it shows, so one deleted from a list named none of
-- them and left them all behind. The card's own delete policy is its owner's, and
-- this runs as the table's, since a deck's owner may delete all of its cards.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE FUNCTION snapcards_delete_deck_cards() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  DELETE FROM flashcard WHERE set_id = OLD.id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION snapcards_delete_deck_cards() FROM PUBLIC;

CREATE TRIGGER card_set_takes_its_cards AFTER DELETE ON card_set
  FOR EACH ROW EXECUTE FUNCTION snapcards_delete_deck_cards();
