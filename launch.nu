# launch.nu — Launch environment for Snapcards.
#
# Usage:
#   sayt launch             bring up Docker Compose stack and detach when healthy.
#   sayt launch --watch     foreground + file sync for live development.
#   sayt launch@host       local machine launch with host-native Metal Ollama.
#   sayt launch@cloudflare  mix local compose with Cloudflare Workers AI.

use compose.nu [compose-vup]
use tools.nu [run-docker-compose]

export def --wrapped main [
	--watch    # foreground + file sync for HMR (dev loop)
	...args
] {
	# Hard down before up: clean previous containers and volumes
	run-docker-compose down -v --timeout 0 --remove-orphans

	# compose-vup returns the exit code
	let exit_code = if $watch {
		compose-vup launch --build --force-recreate --remove-orphans --attach-dependencies --watch ...$args
	} else {
		compose-vup launch --build --force-recreate --remove-orphans --wait ...$args
	}
	if $exit_code != 0 { exit $exit_code }
}
