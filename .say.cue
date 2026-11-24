package say

import (
	"encoding/json"
	"strings"
)

// The deployments this one generated tree releases to and verifies, each a
// platform of `release` and `verify` that runs the generated cloudflare rules
// with the release arguments set as the verb's flags would set them (pronto's
// release-targets.md: --domain, --ssr-origin, --name). Staging's secrets are
// decrypted from SOPS into the environment edge.ts and publish-edge.ts read
// them from; production's are in its Workers' secret store already.
_production: args: {DOMAIN: "snapcards.fun", SSR_ORIGIN: "https://snapcards.fun", NAME: "snapcards"}
_staging: {
	args: {DOMAIN: "snapcards.bonisoft3.com", SSR_ORIGIN: "https://snapcards.bonisoft3.com", NAME: "snapcards-staging"}
	// Google through the operator's broker: no client of snapcards' names
	// this origin.
	env:     {OIDC_BROKER: "https://id.bonisoft3.com"}
	secrets: "staging.secrets.enc.yaml"
}

// A generated cloudflare rule on a deployment's platform: its commands, each
// first loading the deployment's secrets and arguments into the environment.
// Per command, since each runs in its own nu; a verb's `flags:` would set the
// arguments for every platform. Decrypting a flat SOPS file into the
// environment is what `sops exec-env` does, without quoting nu into a shell.
// The rules are named below, not comprehended from the rulemap: a
// comprehension over the rulemap it adds to leaves sayt's rule list
// incomplete.
#OnDeployment: {
	verb:       "release" | "verify"
	platform:   string
	rule:       {priority?: int, cmds: [...{do: string, use?: string}], ...}
	deployment: {args: {[string]: string}, env: *{} | {[string]: string}, secrets?: string}
	let load = "load-env \(json.Marshal({deployment.env, for k, v in deployment.args {"SAY_\(strings.ToUpper(verb))_ARGS_\(k)": v}})); "
	let decrypt = [if deployment.secrets != _|_ {"load-env (^sops decrypt --output-type json \(deployment.secrets) | from json | update cells { into string }); "}, ""][0]
	out: {
		if rule.priority != _|_ {priority: rule.priority}
		"platform": platform
		cmds: [for c in rule.cmds {
			if c.use != _|_ {use: c.use}
			do: decrypt + load + c.do
		}]
	}
}

// Default `cloudflare` targets staging (`snapcards-staging`) without SOPS so
// unattended deploys never touch production; `production` stays explicit.
say: release: rulemap: {
	"cloudflare-staging":          (#OnDeployment & {verb: "release", platform: "cloudflare", rule: say.release.rulemap.cloudflare, deployment: {args: _staging.args, env: _staging.env}}).out & {priority: -1, stop: true}
	production:                    (#OnDeployment & {verb: "release", platform: "production", rule: say.release.rulemap.cloudflare, deployment: _production}).out
	"omnishell-bundle-production": (#OnDeployment & {verb: "release", platform: "production", rule: say.release.rulemap["omnishell-bundle-cloudflare"], deployment: args: _production.args}).out
	staging:                       (#OnDeployment & {verb: "release", platform: "staging", rule: say.release.rulemap.cloudflare, deployment: _staging}).out
	"omnishell-bundle-staging":    (#OnDeployment & {verb: "release", platform: "staging", rule: say.release.rulemap["omnishell-bundle-cloudflare"], deployment: {args: _staging.args, env: _staging.env}}).out
}

say: verify: rulemap: {
	"cloudflare-staging": (#OnDeployment & {verb: "verify", platform: "cloudflare", rule: say.verify.rulemap.cloudflare, deployment: {args: _staging.args, env: _staging.env}}).out & {priority: -1, stop: true}
	production:           (#OnDeployment & {verb: "verify", platform: "production", rule: say.verify.rulemap.cloudflare, deployment: _production}).out
	staging:              (#OnDeployment & {verb: "verify", platform: "staging", rule: say.verify.rulemap.cloudflare, deployment: {args: _staging.args, env: _staging.env}}).out
}
