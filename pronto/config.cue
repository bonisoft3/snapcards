package prontoproject

import "github.com/bonisoft3/pronto/distribution"

pronto: distribution.#Project

// Stripe's CLI forwards signed test-mode webhooks to the local commerce hatch.
pronto: tools: "github:stripe/stripe-cli": "v1.55.3"
