@extern(embed)

package snapcards

import pronto "github.com/bonisoft3/pronto"

_seedPictures: _ @embed(file="migrations/20261102_pictures_are_objects.sql", type=text)

code: state: migrations: "20261102_pictures_are_objects": operations: [{sql: up: _seedPictures}]

_picturesSameOrigin: _ @embed(file="migrations/20261115_pictures_same_origin.sql", type=text)

code: state: migrations: "20261115_pictures_same_origin": operations: [{sql: {up: _picturesSameOrigin, onComplete: true}}]

loop: surface: checks: "pictures-same-origin-migration": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(_platformFlags) --allow-read --allow-env --allow-sys=homedir tests/pictures-same-origin-migration.test.ts"]
	note: "a picture imported under snapcards.fun's address is named by its same-origin path, idempotently"
}
