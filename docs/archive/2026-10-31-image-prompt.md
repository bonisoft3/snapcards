# The image prompt: the reader's words, Gemini for level 3

Status: built 2026-10-31; its contract is [[../index#generation|Generation]]. It replaced
the text levels' picture descriptions and framing, Phoenix at level 3, and the fixed
children's-book style.

## What was wrong

The text levels wrote, per card, an English `image_description` that became the image prompt
and a reader-facing `description` that prefilled the edit sheet; a redraw sent that
description through to the image model. Both were model prose the reader never wrote ("A
silver-colored coin with George Washington's portrait"), and whatever such prose invented the
picture would follow. A style line ("friendly children's book illustration") rode on every
picture whatever the deck was for, and the age combo box was bound to nothing.

## What the trials showed

Same cards (Euro, Quarter, Yen; Paca, Capivara, Tamanduá-bandeira) and seeds, round after round
against the real models:

- **Context, not a caption.** The deck's title in quotes and the region were lettered onto
  coins ("COINS OF THE WORLD", "NEW YORK, USA"). `Subject: … Context: …` mostly stopped it; the
  region went, since it leaked most. Lettering still comes and goes with the seed.
- **One subject.** Without an article the reader's plural details ("coins from around the
  world") drew piles and globes; "one single" was itself lettered ("Single EURO"); "a single"
  holds.
- **Negation draws.** "No ground, no scenery" in the prompt drew grass; such words live in the
  negative prompt, which Phoenix takes and Gemini does not.
- **Age as style.** Three presets drew three distinct styles once each was concrete (flat icon
  with thick outlines; soft picture book; studio photograph). A custom range is said as the
  reader's: `Target age range: …`.
- **The translator.** Llama 3.3 kept regional names untranslated or wrong ("Tamanduá-bandeira"
  → "lesser anteater"); it ran ahead of the configured Gemma 4 only because tsbifrost put it
  first. Gemma 4 named every species right and is on the free allocation; DeepSeek V4.1 Flash
  and GLM 5.3 were also right but need paid billing.
- **No translation for Gemini.** Gemma 4 without thinking, fast enough for the airlock's call
  bound, turned "Paca" into "Agouti"; thinking, it was right at 28–50 s a card. Gemini drew the
  paca, the giant anteater, the agouti and the coins right from the Portuguese words, so level 3
  takes the reader's words as written and only level 2 translates, the reader's word kept beside
  its translation.
- **The model.** Neither the original word, the translation nor the Latin name got Phoenix past
  an alpaca for "Paca" or a mongoose for the giant anteater, and it invented every coin but the
  US quarter. Gemini drew all of them as they are. Flash Lite Image matched Pro on these cards
  at a quarter of the price ($0.034 an image), and 2.5 Flash Image is deprecated.

## Rejected

- **Phoenix for level 3.** Free, but its ceiling is real objects it has not seen.
- **A model's identifying phrase or the Latin name.** The first is model prose again; the
  second did not help.
- **A prompt line naming the failure.** "Often the same word; never swap it for a related
  species" fixed Paca and would need a line for every next collision.
- **Gemini 3 Pro Image.** Accurate, at four times Flash Lite's price for no gain on these cards.
- **Batch pricing.** Half the price, but asynchronous, and a reader watches the deck draw.
