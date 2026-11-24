@extern(embed)

package snapcards

_deckTakesItsCards: _ @embed(file="migrations/20261103_deck_takes_its_cards.sql", type=text)

_orphanCardsGone: _ @embed(file="migrations/20261103_orphan_cards_gone.sql", type=text)

code: state: migrations: "20261103_deck_takes_its_cards": operations: [{sql: up: _deckTakesItsCards}]
code: state: migrations: "20261103_orphan_cards_gone": operations: [{sql: up: _orphanCardsGone}]

_deckTakesItsTranslations: _ @embed(file="migrations/20261103_deck_takes_its_translations.sql", type=text)

code: state: migrations: "20261103_deck_takes_its_translations": operations: [{sql: up: _deckTakesItsTranslations}]
