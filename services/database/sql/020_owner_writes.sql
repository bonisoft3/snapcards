-- Owner writes over public-read tables. #Access has no "everyone reads, the
-- owner writes" mode (plugins/pronto/docs/access.md): `public` emits a SELECT
-- arm alone, so these arms are added here. RLS policies are permissive and OR
-- together, so this widens nothing the declared mode's mirror refuses.
--
-- A card is written by its own owner, never into a deck of someone else's. A
-- deck and its cards reach the server as separate writes in no fixed order, so
-- a card may arrive before its deck: what is refused is a deck that exists and
-- is not the writer's. A curated deck has no owner and takes no reader's write.
--
-- Idempotent via DROP POLICY IF EXISTS.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

DROP POLICY IF EXISTS card_set_app_user_insert ON card_set;
CREATE POLICY card_set_app_user_insert ON card_set FOR INSERT TO app_user
  WITH CHECK (owner = auth_uid());
-- WITH CHECK on update too: a PATCH could otherwise hand the deck to somebody else.
DROP POLICY IF EXISTS card_set_app_user_update ON card_set;
CREATE POLICY card_set_app_user_update ON card_set FOR UPDATE TO app_user
  USING (owner = auth_uid()) WITH CHECK (owner = auth_uid());
DROP POLICY IF EXISTS card_set_app_user_delete ON card_set;
CREATE POLICY card_set_app_user_delete ON card_set FOR DELETE TO app_user
  USING (owner = auth_uid());

DROP POLICY IF EXISTS flashcard_app_user_insert ON flashcard;
CREATE POLICY flashcard_app_user_insert ON flashcard FOR INSERT TO app_user
  WITH CHECK (owner = auth_uid() AND NOT EXISTS (
    SELECT 1 FROM card_set s WHERE s.id = flashcard.set_id AND s.owner IS DISTINCT FROM auth_uid()));
DROP POLICY IF EXISTS flashcard_app_user_update ON flashcard;
CREATE POLICY flashcard_app_user_update ON flashcard FOR UPDATE TO app_user
  USING (owner = auth_uid()) WITH CHECK (owner = auth_uid() AND NOT EXISTS (
    SELECT 1 FROM card_set s WHERE s.id = flashcard.set_id AND s.owner IS DISTINCT FROM auth_uid()));
DROP POLICY IF EXISTS flashcard_app_user_delete ON flashcard;
CREATE POLICY flashcard_app_user_delete ON flashcard FOR DELETE TO app_user
  USING (owner = auth_uid());

COMMIT;
