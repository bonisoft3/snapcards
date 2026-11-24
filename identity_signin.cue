package snapcards

import "github.com/bonisoft3/pronto/identity"

// Google signs a person in by its own button, for snapcards' own client
// (Google Cloud project snapcards-fun); staging signs in through the broker
// in its place (.say.cue). A release turns it on.
identity.#Signin & {
	signin: {
		providers: ["google"]
		clients: google: {client: "939531096347-r6sd09nil62nff62baq2it13mcbbekjg.apps.googleusercontent.com", credential: true}
	}
}
