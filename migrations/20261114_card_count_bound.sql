SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- A draft asks for at most 20 cards, the largest deck the form makes: the
-- bound the program states (GenerationDraft.card_count) on a table whose
-- bootstrap bytes (005_create_tables) keep the lower bound alone.
ALTER TABLE "generation_draft" DROP CONSTRAINT IF EXISTS "generation_draft_card_count_max";
ALTER TABLE "generation_draft" ADD CONSTRAINT "generation_draft_card_count_max" CHECK ("card_count" <= 20) NOT VALID;
