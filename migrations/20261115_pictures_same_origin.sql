SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Cards imported from the app snapcards.fun served before this one may name
-- their pictures by that address. Its path is this origin's /img route, which
-- serves the imported bucket's objects under the plane's logical name
-- (20261102_pictures_are_objects), so a picture is a path on every deployment
-- and a staging copy of the data reaches nothing of production's.
UPDATE flashcard
  SET back = replace(regexp_replace(back, '^https?://(www\.)?snapcards\.fun/', '/'), 's3://trash-362115-snapcards-bytes/', 's3://mecha-objects/')
  WHERE back ~ '^https?://(www\.)?snapcards\.fun/';
-- A cover is its deck's first card's picture (20261108_deck_cover).
UPDATE deck_stats
  SET cover = replace(regexp_replace(cover, '^https?://(www\.)?snapcards\.fun/', '/'), 's3://trash-362115-snapcards-bytes/', 's3://mecha-objects/')
  WHERE cover ~ '^https?://(www\.)?snapcards\.fun/';
