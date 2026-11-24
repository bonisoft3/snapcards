SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Cloudprinter textbook preflight requires >= 24 pages; pre-deploy Brazil orders
-- of <= 11 cards carry 20/22-page quotes or stored book PDFs.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM print_order
    WHERE country = 'BR' AND cards <= 11
      AND (status IN ('quoting_br', 'converting', 'opening', 'checking', 'confirming', 'placing_br')
        OR (status = 'awaiting_payment' AND cover_file IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'a Brazil print order under 12 cards is in flight with a pre-24-page quote or book PDF';
  END IF;
END $$;

DELETE FROM print_order WHERE country = 'BR' AND cards <= 11 AND status = 'quoted';
