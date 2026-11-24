SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- What a reader may state of an order, and the abuse bound. Everything else on the
-- row comes from an effect's outcome, so a browser cannot set its own price or say
-- it paid; the machine's guard holds every move of `status`.
REVOKE INSERT, UPDATE ON print_order FROM anon, app_user;
GRANT INSERT (id, title, stock, cards, country) ON print_order TO app_user;
GRANT UPDATE (status, checks, delivery, artwork, title) ON print_order TO app_user;

-- Guest ids are free, so a limit per account stops nobody. Unpaid orders in flight
-- bound what an abuser costs, Prodigi's 1,000 quotes an hour included, and a slot
-- frees itself when its session has ended, with no clock or counter. One abuser can
-- block checkout until theirs expire.
CREATE FUNCTION print_order_admit() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('print_order_admit'));
  IF (SELECT count(*) FROM print_order
       WHERE paid_at IS NULL AND created_at > now() - interval '150 minutes') >= 500 THEN
    RAISE EXCEPTION 'too many unpaid orders' USING ERRCODE = 'PT429';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER print_order_admit BEFORE INSERT ON print_order
  FOR EACH ROW EXECUTE FUNCTION print_order_admit();

-- The session charges what the row holds, so the address and the files are frozen
-- from the moment it is asked for, and it is not asked for without them.
CREATE FUNCTION print_order_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'opening' AND OLD.status = 'quoted' THEN
    IF NEW.delivery IS NULL OR NEW.artwork IS NULL OR json_array_length(NEW.artwork) <> NEW.cards THEN
      RAISE EXCEPTION 'an order opens with its delivery and one file per card' USING ERRCODE = 'PT400';
    END IF;
  ELSIF OLD.status <> 'draft' AND OLD.status <> 'quoted' AND (
    NEW.delivery::jsonb IS DISTINCT FROM OLD.delivery::jsonb OR NEW.artwork::jsonb IS DISTINCT FROM OLD.artwork::jsonb OR
    NEW.title IS DISTINCT FROM OLD.title
  ) THEN
    RAISE EXCEPTION 'an order is frozen once its session is asked for' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER print_order_frozen BEFORE UPDATE ON print_order
  FOR EACH ROW EXECUTE FUNCTION print_order_frozen();
