SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Hindi among the languages a deck or card translation is written in: the set
-- the program states (DeckTranslation.lang, CardTranslation.lang) on tables
-- whose bootstrap bytes (005_create_tables) name the column check without it.
ALTER TABLE "deck_translation" DROP CONSTRAINT IF EXISTS "deck_translation_lang_check";
ALTER TABLE "deck_translation" ADD CONSTRAINT "deck_translation_lang_check" CHECK ("lang" IN ('pt', 'es', 'en', 'he', 'zh', 'hi')) NOT VALID;
ALTER TABLE "card_translation" DROP CONSTRAINT IF EXISTS "card_translation_lang_check";
ALTER TABLE "card_translation" ADD CONSTRAINT "card_translation_lang_check" CHECK ("lang" IN ('pt', 'es', 'en', 'he', 'zh', 'hi')) NOT VALID;
