-- A deck's translations go with it, as its cards do, and those of decks already
-- gone. A deck's words are public to write, so no reader owns them to delete.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE FUNCTION snapcards_delete_deck_translations() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  DELETE FROM card_translation WHERE set_id = OLD.id;
  DELETE FROM deck_translation WHERE set_id = OLD.id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION snapcards_delete_deck_translations() FROM PUBLIC;
CREATE TRIGGER card_set_takes_its_translations AFTER DELETE ON card_set
  FOR EACH ROW EXECUTE FUNCTION snapcards_delete_deck_translations();

DELETE FROM card_translation t WHERE NOT EXISTS (SELECT 1 FROM card_set s WHERE s.id = t.set_id);
DELETE FROM deck_translation t WHERE NOT EXISTS (SELECT 1 FROM card_set s WHERE s.id = t.set_id);
