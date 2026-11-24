-- The reader's own `me` row, written inside the auth service's own insert of
-- the person, so it exists on the first paint after a guest is minted; a
-- pipeline's round trip is seconds. AFTER INSERT because me.id references
-- app_user(id). SECURITY DEFINER because the reader holds no write on `me`.

SET lock_timeout = '5s';
SET statement_timeout = '60s';

BEGIN;

CREATE OR REPLACE FUNCTION snapcards_me_provision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO me (id) VALUES (NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS snapcards_me_provision ON app_user;
CREATE TRIGGER snapcards_me_provision
  AFTER INSERT ON app_user
  FOR EACH ROW EXECUTE FUNCTION snapcards_me_provision();

DROP POLICY IF EXISTS me_app_user_insert ON me;
DROP POLICY IF EXISTS me_app_user_update ON me;
DROP POLICY IF EXISTS me_app_user_delete ON me;

COMMIT;
