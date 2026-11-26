@extern(embed)
package snapcards

import (
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	pronto "github.com/bonisoft3/pronto"
)

_commerceSchema: _ @embed(file="commerce/schema.sql", type=text)
// What production's database ran as the order's own migration, before it took
// local currency, Pix and the re-check ([[../../plugins/pronto/docs/schema-change-admission#A new entity on a live database]]).
_printOrderApplied: _ @embed(file="migrations/20261106_print_order.json")
_printOrderPaymentsApplied: _ @embed(file="migrations/20261106_print_order_payments.json")
_printOrderFileApplied: _ @embed(file="migrations/20261107_print_order_file.json")
_boundedJobKeysSql: _ @embed(file="migrations/20261113_bounded_job_keys.sql", type=text)
_jobKeyOnceSql:     _ @embed(file="migrations/20261113_job_key_once.sql", type=text)
_sessionModeSql:    _ @embed(file="migrations/20261115_session_mode.sql", type=text)
_brFlipDeckSql:     _ @embed(file="migrations/20261118_br_spiral_flip_deck.sql", type=text)
_confirmThreadSql:  _ @embed(file="migrations/20261119_order_confirmation_thread.sql", type=text)
_orderTrackingSql:  _ @embed(file="migrations/20261119_order_tracking_and_ship_mail.sql", type=text)
_machineClockSql:   _ @embed(file="migrations/20261121_machine_clock.sql", type=text)
_brMinPagesSql:     _ @embed(file="migrations/20261123_br_textbook_min_pages.sql", type=text)
_printCountryInSql: _ @embed(file="migrations/20261125_print_country_in.sql", type=text)

// Sandbox or live is each deployment's own: its secret store holds Stripe's,
// Prodigi's and Cloudprinter's keys, STRIPE_PUBLISHABLE_KEY and PRODIGI_ORIGIN
// (commerce/README.md#going-live), and an order reads its mode from its session.
// A percentage added to the printer's non-shipping cost; shipping passes through at 1x.
_printMarkupPercent: 80
_printCountries: ["BR", "AR", "IL", "US", "GB", "CN", "IN"]
// Each country pays in its own currency (commerce/README.md#price).
_printCurrencies: close({for c in _printCountries {(c): =~"^[a-z]{3}$"}}) & {
	BR: "brl", AR: "ars", IL: "ils", US: "usd", GB: "gbp", CN: "cny", IN: "inr"
}
// While a payment is unsettled, Stripe is asked again this often, in case its
// webhook was lost: a session lives 2 hours (print-session's LIFETIME_SECONDS),
// and a Pix finished on its last minute stays payable for Stripe's default
// 24 hours, so a read every 10 minutes is at most ~160 per order, and past 27
// hours from the order no session can still pay and the reads stop. The webhook
// and the reader's refresh still ask after that.
_recheckMs:            "600000"
_recheckHorizon:       "27 hours"
// While a placed order is still in production or transit, the printer is asked
// again every 2 hours for up to 30 days so tracking and shipment mail arrive
// even if a CloudSignal or Prodigi webhook is missed.
_vendorRecheckMs:      "7200000"
_vendorRecheckHorizon: "30 days"
_mailTo:               "davi@davi.eng.br"

_prodigiSink: {
	origin: secret: "PRODIGI_ORIGIN"
	targets: docker: bridge: "prodigi"
	credential: {header: "X-API-Key", secret: "PRODIGI_API_KEY"}
}
_cloudprinterSink: {
	origin: "https://api.cloudprinter.com"
	targets: docker: bridge: "cloudprinter"
}
_stripeSink: {
	origin: "https://api.stripe.com"
	targets: docker: bridge: "stripe"
	credential: {scheme: "Bearer", secret: "STRIPE_SECRET_KEY"}
}
_mailSink: {
	origin: "https://api.cloudflare.com"
	targets: docker: bridge: "mail"
	credential: {scheme: "Bearer", secret: "MAIL_API_TOKEN"}
}
_mailFacts: {
	to:       _mailTo
	// Live or test as the order's own Stripe session says, never the release.
	session_id: "NEW.session_id"
	id:       "NEW.id"
	title:    "NEW.title"
	stock:    "NEW.stock"
	cards:    "NEW.cards"
	country:  "NEW.country"
	total:    "NEW.total"
	currency: "NEW.currency"
	email:    "NEW.customer_email"
	delivery: "NEW.delivery"
	// The print file's key in the blob plane, which the mail links.
	print_file: "NEW.print_file"
	cover_file: "NEW.cover_file"
}

code: {
	capabilities: hatches: {
		"print-checkout": {
			kind: "host-dom"
			src:  "shell/hatches/print-checkout.js"
			files: ["shell/hatches/print-checkout.js"]
			note: "Draws each card's 6×4 in artwork on a canvas and uploads it, opens Checkout from the order row and shows its state; for a print shop, composes one A6 page per face for the browser's print dialog; Pages simulates the external services."
		}
		"checkout-simulator": {kind: "container", note: "Stripe Checkout for the compose stack: its API, its hosted page, and webhooks to the door"}
		"prodigi-simulator": {kind: "container", note: "Prodigi for the compose stack: artwork fetched through the door as a lab would, callbacks to the door"}
		"cloudprinter-simulator": {kind: "container", note: "Cloudprinter CloudCore for the compose stack: cover and book PDFs fetched through the door, CloudSignal webhooks to the door"}
		"mail-simulator": {kind: "container", note: "Cloudflare's Email Sending API for the compose stack, handed to Mailpit"}
	}
	capabilities: vendored: "print-payment": {
		isolation: "realm"
		subdomain: "payments"
		grants: ["payment"]
		ports: {
			reads: ["DeliveryDraft"]
			raises: checkout: {type: "object", fields: {
				outcome: {type: "string", maxLength: 16, values: ["completed", "cancelled"]}
			}}
		}
		src:   "shell/units/print-payment/index.html"
		files: ["shell/units/print-payment/index.html"]
		note:  "Embedded Stripe Checkout in the payments subdomain realm with the Payment Request API delegated"
	}
	state: entities: {
		PrintOrder: {
			id: "0xf01a0e14b04263ee"
			table:      "print_order"
			durability: "server"
			access: {scope: "private", owner: "owner_id"}
			fields: [
				{ordinal: 1, name: "id", type: "uuid", pk: true, default: "gen_random_uuid()"},
				{ordinal: 2, name: "owner_id", type: "uuid", ref: "app_user", default: "auth_uid()"},
				{ordinal: 3, name: "status", type: "string", default: "'draft'"},
				{ordinal: 4, name: "created_at", type: "timestamp", default: "now()"},
				{ordinal: 5, name: "title", type: "string", cel: "this.size() > 0 && this.size() <= 120"},
				{ordinal: 6, name: "stock", type: "string", cel: "this in ['gloss', 'mohawk']"},
				{ordinal: 7, name: "cards", type: "int32", cel: "this >= 1 && this <= 100"},
				{ordinal: 8, name: "country", type: "string", cel: "this in [\(strings.Join([for c in _printCountries {"'\(c)'"}], ", "))]"},
				// The free text, the pin and the postal fields, as independent statements.
				{ordinal: 9, name: "delivery", type: "json", required: false},
				{ordinal: 10, name: "artwork", type: "json", required: false},
				// In minor units of `currency`, from the price's outcome.
				{ordinal: 11, name: "item", type: "int32", required: false},
				{ordinal: 12, name: "shipping", type: "int32", required: false},
				{ordinal: 13, name: "total", type: "int32", required: false},
				// The printer's total, in USD cents.
				{ordinal: 14, name: "cost", type: "int32", required: false},
				{ordinal: 15, name: "currency", type: "string", required: false},
				{ordinal: 16, name: "sku", type: "string", required: false},
				{ordinal: 17, name: "shipping_method", type: "string", required: false},
				{ordinal: 18, name: "session_id", type: "string", required: false},
				{ordinal: 19, name: "checkout_url", type: "string", required: false},
				// Bumped by every signal or refresh, since each read is a new ledger key.
				{ordinal: 20, name: "checks", type: "int32", default: "0"},
				{ordinal: 21, name: "payment_state", type: "string", required: false},
				{ordinal: 22, name: "payment_intent", type: "string", required: false},
				{ordinal: 23, name: "customer_email", type: "string", required: false},
				{ordinal: 24, name: "paid_at", type: "timestamp", required: false},
				{ordinal: 25, name: "vendor_order_id", type: "string", required: false},
				{ordinal: 26, name: "vendor_state", type: "string", required: false},
				{ordinal: 27, name: "vendor_checks", type: "int32", default: "0"},
				{ordinal: 28, name: "failure", type: "string", required: false},
				// The printer's shipping line, in USD cents.
				{ordinal: 29, name: "cost_shipping", type: "int32", required: false},
				// The Stripe FX quote that priced the order, its rates as Stripe gave
				// them, and the BRL in centavos the price is set to receive.
				{ordinal: 30, name: "fx_quote", type: "string", required: false},
				{ordinal: 31, name: "fx_rates", type: "json", required: false},
				{ordinal: 32, name: "fx_brl", type: "int32", required: false},
				// When the reader asked to pay, which the session's lifetime counts from.
				{ordinal: 33, name: "opened_at", type: "timestamp", required: false},
				// The print file's key in the blob plane, stored before the order could be paid.
				{ordinal: 34, name: "print_file", type: "string", required: false},
				// Brazil's quoted CEP (Correios SEDEX varies by postal zone) and 2-page cover PDF key.
				{ordinal: 35, name: "postal_code", type: "string", default: "''", cel: "this.size() <= 40"},
				{ordinal: 36, name: "cover_file", type: "string", required: false},
				{ordinal: 37, name: "mail_message_id", type: "string", required: false},
				{ordinal: 38, name: "tracking_carrier", type: "string", required: false},
				{ordinal: 39, name: "tracking_number", type: "string", required: false},
				{ordinal: 40, name: "tracking_url", type: "string", required: false},
				{ordinal: 41, name: "shipped_at", type: "timestamp", required: false},
			]
			indexes: [{on: "owner_id"}]
		}
	}
	state: mecha: rows: PrintOrderMachine: {
		name:    "PrintOrderMachine"
		entity:  "PrintOrder"
		field:   "status"
		initial: "draft"
		states: {
			draft: on: {
				quote: {target: "quoting", guard: "NEW.country <> 'BR'"}
				quote_br: {target: "quoting_br", guard: "NEW.country = 'BR'"}
			}
			quoting: invoke: {
				src: "print-quote"
				onDone: {target: "converting", actions: [{assign: {
					cost: {raw: "(outcome->'data'->>'cost')::int"}
					cost_shipping: {raw: "(outcome->'data'->>'shipping')::int"}
					currency: {raw: "CASE NEW.country " + strings.Join([for c in _printCountries {"WHEN '\(c)' THEN '\(_printCurrencies[c])'"}], " ") + " END"}
					sku: {raw: "outcome->'data'->>'sku'"}
					shipping_method: {raw: "outcome->'data'->>'shipping_method'"}
				}}]}
				onError: {target: "quote_failed", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			quoting_br: invoke: {
				src: "print-quote-br"
				onDone: {target: "converting", actions: [{assign: {
					cost: {raw: "(outcome->'data'->>'cost')::int"}
					cost_shipping: {raw: "(outcome->'data'->>'shipping')::int"}
					currency: {raw: "'brl'"}
					sku: {raw: "outcome->'data'->>'sku'"}
					shipping_method: {raw: "outcome->'data'->>'shipping_method'"}
				}}]}
				onError: {target: "quote_failed", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			converting: invoke: {
				src: "print-fx"
				onDone: {target: "quoted", actions: [{assign: {
					item: {raw: "(outcome->'data'->>'item')::int"}
					shipping: {raw: "(outcome->'data'->>'shipping')::int"}
					total: {raw: "(outcome->'data'->>'total')::int"}
					fx_quote: {raw: "outcome->'data'->>'quote'"}
					fx_rates: {raw: "(outcome->'data'->'rates')::json"}
					fx_brl: {raw: "(outcome->'data'->>'brl')::int"}
				}}]}
				onError: {target: "quote_failed", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			quote_failed: type: "final"
			quoted: on: open: {target: "opening", actions: [{assign: opened_at: {raw: "machine_clock()"}}]}
			opening: invoke: {
				src: "print-session"
				onDone: {target: "awaiting_payment", actions: [{assign: {
					session_id: {raw: "outcome->'data'->>'id'"}
					checkout_url: {raw: "outcome->'data'->>'url'"}
					// The row keeps the keys, which a later effect reads with sink.blob.
					print_file: {raw: "substring(outcome->'data'->>'file' from 'mecha-objects/(.+)$')"}
					cover_file: {raw: "substring(outcome->'data'->>'cover' from 'mecha-objects/(.+)$')"}
				}}]}
				onError: {target: "open_failed", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			open_failed: type: "final"
			// A webhook, the reader's refresh or the clock; each only asks Stripe again.
			awaiting_payment: {
				on: recheck: "checking"
				after: (_recheckMs): {
					target: "checking"
					guard:  "COALESCE(OLD.opened_at, OLD.created_at) > machine_clock() - interval '\(_recheckHorizon)'"
					actions: [{assign: checks: {raw: "OLD.checks + 1"}}]
				}
			}
			checking: invoke: {
				src: "print-check"
				onDone: {target: "confirming", actions: [{assign: {
					paid_at: {raw: "machine_clock()"}
					payment_state: {raw: "'paid'"}
					payment_intent: {raw: "outcome->'data'->>'payment_intent'"}
					customer_email: {raw: "outcome->'data'->>'email'"}
				}}]}
				// A session that ended unpaid can never pay; anything else, a Pix the
				// bank has yet to settle included, waits for the next read.
				onError: [
					{target: "unpaid", guard: "outcome->'data'->>'state' IN ('expired', 'failed')", actions: [{assign: payment_state: {raw: "outcome->'data'->>'state'"}}]},
					{target: "awaiting_payment", actions: [{assign: payment_state: {raw: "COALESCE(outcome->'data'->>'state', outcome->>'kind')"}}]},
				]
			}
			confirming: invoke: {
				src: "print-confirm"
				onDone: [
					{target: "placing_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL", actions: [{assign: mail_message_id: {raw: "outcome->'data'->>'message_id'"}}]},
					{target: "placing", actions: [{assign: mail_message_id: {raw: "outcome->'data'->>'message_id'"}}]},
				]
				onError: [
					{target: "placing_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL"},
					{target: "placing"},
				]
			}
			unpaid: type: "final"
			placing: invoke: {
				src: "print-place"
				onDone: {target: "recording", actions: [{assign: {
					vendor_order_id: {raw: "outcome->'data'->>'id'"}
					vendor_state: {raw: "CASE outcome->'data'->>'stage' WHEN 'OnHold' THEN 'on_hold' ELSE 'in_progress' END"}
				}}]}
				onError: {target: "alerting", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			placing_br: invoke: {
				src: "print-place-br"
				onDone: {target: "recording", actions: [{assign: {
					vendor_order_id: {raw: "outcome->'data'->>'id'"}
					vendor_state: {raw: "COALESCE(outcome->'data'->>'stage', 'in_progress')"}
				}}]}
				onError: {target: "alerting", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			recording: invoke: {
				src: "print-record"
				onDone: [{target: "placed_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL"}, {target: "placed"}]
				onError: [{target: "placed_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL"}, {target: "placed"}]
			}
			placed: {
				on: vendor_changed: "vendor_checking"
				after: (_vendorRecheckMs): {
					target: "vendor_checking"
					guard:  "COALESCE(OLD.vendor_state, '') NOT IN ('completed', 'cancelled') AND COALESCE(OLD.paid_at, OLD.created_at) > machine_clock() - interval '\(_vendorRecheckHorizon)'"
					actions: [{assign: vendor_checks: {raw: "OLD.vendor_checks + 1"}}]
				}
			}
			placed_br: {
				on: vendor_changed_br: "vendor_checking_br"
				after: (_vendorRecheckMs): {
					target: "vendor_checking_br"
					guard:  "COALESCE(OLD.vendor_state, '') NOT IN ('completed', 'cancelled') AND COALESCE(OLD.paid_at, OLD.created_at) > machine_clock() - interval '\(_vendorRecheckHorizon)'"
					actions: [{assign: vendor_checks: {raw: "OLD.vendor_checks + 1"}}]
				}
			}
			vendor_checking: invoke: {
				src: "print-status"
				onDone: [
					{
						target: "notifying_shipped"
						guard:  "OLD.shipped_at IS NULL AND outcome->'data'->>'state' IN ('shipped', 'partially_shipped', 'completed')"
						actions: [{assign: {
							vendor_state:     {raw: "outcome->'data'->>'state'"}
							tracking_carrier: {raw: "COALESCE(NULLIF(outcome->'data'->>'carrier', ''), OLD.tracking_carrier)"}
							tracking_number:  {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_number', ''), OLD.tracking_number)"}
							tracking_url:     {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_url', ''), OLD.tracking_url)"}
							shipped_at:       {raw: "machine_clock()"}
						}}]
					},
					{
						target: "placed"
						actions: [{assign: {
							vendor_state:     {raw: "outcome->'data'->>'state'"}
							tracking_carrier: {raw: "COALESCE(NULLIF(outcome->'data'->>'carrier', ''), OLD.tracking_carrier)"}
							tracking_number:  {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_number', ''), OLD.tracking_number)"}
							tracking_url:     {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_url', ''), OLD.tracking_url)"}
						}}]
					},
				]
				onError: {target: "alerting", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			vendor_checking_br: invoke: {
				src: "print-status-br"
				onDone: [
					{
						target: "notifying_shipped"
						guard:  "OLD.shipped_at IS NULL AND outcome->'data'->>'state' IN ('shipped', 'partially_shipped', 'completed')"
						actions: [{assign: {
							vendor_state:     {raw: "outcome->'data'->>'state'"}
							tracking_carrier: {raw: "COALESCE(NULLIF(outcome->'data'->>'carrier', ''), OLD.tracking_carrier)"}
							tracking_number:  {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_number', ''), OLD.tracking_number)"}
							tracking_url:     {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_url', ''), OLD.tracking_url)"}
							shipped_at:       {raw: "machine_clock()"}
						}}]
					},
					{
						target: "placed_br"
						actions: [{assign: {
							vendor_state:     {raw: "outcome->'data'->>'state'"}
							tracking_carrier: {raw: "COALESCE(NULLIF(outcome->'data'->>'carrier', ''), OLD.tracking_carrier)"}
							tracking_number:  {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_number', ''), OLD.tracking_number)"}
							tracking_url:     {raw: "COALESCE(NULLIF(outcome->'data'->>'tracking_url', ''), OLD.tracking_url)"}
						}}]
					},
				]
				onError: {target: "alerting", actions: [{assign: failure: {raw: "(outcome->>'kind') || ': ' || COALESCE(outcome->>'data', '')"}}]}
			}
			notifying_shipped: invoke: {
				src: "print-shipped"
				onDone: [{target: "placed_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL"}, {target: "placed"}]
				onError: [{target: "placed_br", guard: "NEW.country = 'BR' AND NEW.cover_file IS NOT NULL"}, {target: "placed"}]
			}
			alerting: invoke: {src: "print-alert", onDone: "attention", onError: "attention"}
			attention: type: "final"
		}
	}
	// Each container is already its provider's simulator, so the local stack
	// runs it as it is ({}); no release target deploys one.
	state: bridges: {
		stripe: {container: "checkout-simulator", port: 8080, simulator: {}}
		prodigi: {container: "prodigi-simulator", port: 8080, simulator: {}}
		cloudprinter: {container: "cloudprinter-simulator", port: 8080, simulator: {}}
		mail: {container: "mail-simulator", port: 8080, simulator: {}}
	}
	state: signals: {
		stripe: {machine: "PrintOrderMachine", event: "recheck", id: {body: ["data", "object", "client_reference_id"]}, count: "checks"}
		prodigi: {machine: "PrintOrderMachine", event: "vendor_changed", id: {path: true}, count: "vendor_checks"}
		cloudprinter: {machine: "PrintOrderMachine", event: "vendor_changed_br", id: {body: ["order_reference"]}, count: "vendor_checks"}
	}
	state: effects: {
		"print-quote": {
			// Prodigi quotes in USD alone; Stripe converts it (print-fx).
			input: {stock: "NEW.stock", cards: "NEW.cards", country: "NEW.country", currency: "usd"}
			sink: _prodigiSink & {idempotent: true}
			note: "A quote changes nothing at Prodigi"
		}
		"print-quote-br": {
			input: {stock: "NEW.stock", cards: "NEW.cards", postal_code: "NEW.postal_code", currency: "USD"}
			secrets: ["CLOUDPRINTER_API_KEY"]
			sink: _cloudprinterSink & {idempotent: true}
			note: "A domestic Brazil quote changes nothing at Cloudprinter"
		}
		"print-fx": {
			input: {cost: "NEW.cost", shipping: "NEW.cost_shipping", currency: "NEW.currency", markup_percent: _printMarkupPercent}
			sink: _stripeSink & {idempotent: true, contentType: "application/x-www-form-urlencoded"}
			note: "Stripe answers a repeated Idempotency-Key with the quote it made"
		}
		"print-session": {
			// An order already opening when opened_at arrived keeps the instant it asked Stripe with.
			input: {id: "NEW.id", total: "NEW.total", currency: "NEW.currency", country: "NEW.country", title: "NEW.title", artwork: "NEW.artwork", email: {raw: "NULLIF(NEW.delivery->'contact'->>'email', '')"}, opened_epoch: {raw: "extract(epoch from COALESCE(NEW.opened_at, NEW.created_at))::bigint"}}
			endowments: ["Pdf"]
			// The page's key travels with the session it opens, so the bundle names no mode.
			secrets: ["STRIPE_PUBLISHABLE_KEY"]
			sink: _stripeSink & {idempotent: true, contentType: "application/x-www-form-urlencoded"}
			note: "Stripe answers a repeated Idempotency-Key with the session it made, and the print files are rebuilt from the same content keys"
		}
		"print-check": {
			key: ["id", "checks"]
			input: {id: "NEW.id", session_id: "NEW.session_id", total: "NEW.total", currency: "NEW.currency"}
			sink: _stripeSink & {idempotent: true}
			note: "A read of the session"
		}
		"print-place": {
			input: {id: "NEW.id", artwork: "NEW.artwork", delivery: "NEW.delivery", sku: "NEW.sku", shipping_method: "NEW.shipping_method", email: "NEW.customer_email"}
			sink: _prodigiSink & {idempotent: true}
			note: "A repeated idempotencyKey answers AlreadyExists with the first order, ignoring a changed body (sandbox, 2026-11-05)"
		}
		"print-place-br": {
			input: {id: "NEW.id", title: "NEW.title", stock: "NEW.stock", cards: "NEW.cards", delivery: "NEW.delivery", sku: "NEW.sku", shipping_method: "NEW.shipping_method", email: "NEW.customer_email", print_file: "NEW.print_file", cover_file: "NEW.cover_file"}
			secrets: ["CLOUDPRINTER_API_KEY"]
			sink: _cloudprinterSink & {idempotent: true}
			note: "CloudCore enforces unique order reference (409 on repeat), reconciled via /orders/info"
		}
		"print-status": {
			key: ["id", "vendor_checks"]
			input: {id: "NEW.id", vendor_order_id: "NEW.vendor_order_id"}
			sink: _prodigiSink & {idempotent: true}
			note: "A read of the order"
		}
		"print-status-br": {
			key: ["id", "vendor_checks"]
			input: {id: "NEW.id", vendor_order_id: "NEW.vendor_order_id"}
			secrets: ["CLOUDPRINTER_API_KEY"]
			sink: _cloudprinterSink & {idempotent: true}
			note: "A read of the Cloudprinter order"
		}
		"print-confirm": {
			input: _mailFacts & {sku: "NEW.sku"}
			secrets: ["MAIL_ACCOUNT_ID"]
			sink: _mailSink & {idempotent: false}
			reentry: "repeat"
			note:    "Immediate buyer order confirmation before printer placement; returns Message-ID for threading"
		}
		"print-record": {
			input: _mailFacts & {sku: "NEW.sku", cost: "NEW.cost", fx_quote: "NEW.fx_quote", fx_brl: "NEW.fx_brl", vendor_order_id: "NEW.vendor_order_id", mail_message_id: "NEW.mail_message_id"}
			secrets: ["MAIL_ACCOUNT_ID"]
			sink: _mailSink & {idempotent: false}
			reentry: "repeat"
			note:    "Replies in the buyer's confirmation thread once the printer accepts, and archives the operator record"
		}
		"print-shipped": {
			input: _mailFacts & {sku: "NEW.sku", vendor_order_id: "NEW.vendor_order_id", mail_message_id: "NEW.mail_message_id", tracking_carrier: "NEW.tracking_carrier", tracking_number: "NEW.tracking_number", tracking_url: "NEW.tracking_url"}
			secrets: ["MAIL_ACCOUNT_ID"]
			sink: _mailSink & {idempotent: false}
			reentry: "repeat"
			note:    "Replies in the buyer's confirmation thread with carrier and tracking details once shipped"
		}
		"print-alert": {
			input: _mailFacts & {failure: "NEW.failure"}
			// The only word the operator gets of a paid order its printer does not have:
			// the queue's backoff, capped at about 6 hours a try, spends about 3 days.
			attempts: 20
			secrets: ["MAIL_ACCOUNT_ID"]
			sink: _mailSink & {idempotent: false}
			reentry: "repeat"
			note:    "A second alert costs a glance, and a lost one leaves a paid order unseen"
		}
	}
	state: migrations: "20261106_print_order": _printOrderApplied
	// After 20261106_print_order, the order's own migration, has made its table.
	state: migrations: "20261106_print_order_guards": {operations: [{sql: {up: _commerceSchema, onComplete: true}}]}
	// The columns past what the order was made with, its re-check timer's tables,
	// and the machine as it was then, as production ran it: computed from the
	// machine, its bytes moved with every later change, and an applied script
	// that changes is refused.
	state: migrations: "20261106_print_order_payments": _printOrderPaymentsApplied
	// The print file stored with the session, which the session's lifetime counts
	// from the moment the order asked to open, and an address shipped to the
	// country quoted and whole on the lab's line, as v0.23.0 ran it. Computed in
	// place, its machine SQL was evaluated once per instance of the program the
	// emitter builds, and most of a generate's time went to it.
	state: migrations: "20261107_print_order_file": _printOrderFileApplied
	// The machine restated with its jobs keyed by the ledger key's digest, the
	// emitter's rule since (program.cue baseline.carried), and the card art's
	// trigger wrapped the same way.
	state: migrations: "20261113_bounded_job_keys": {operations: [{sql: {up: _boundedJobKeysSql, onComplete: true}}]}
	state: migrations: "20261113_job_key_once":     {operations: [{sql: {up: _jobKeyOnceSql, onComplete: true}}]}
	// The order's jobs read test or live from its Stripe session, so every
	// deployment runs the same migrations.
	state: migrations: "20261115_session_mode": {operations: [{sql: {up: _sessionModeSql, onComplete: true}}]}
	state: migrations: "20261118_br_spiral_flip_deck": {operations: [{sql: {up: _brFlipDeckSql, onComplete: true}}]}
	state: migrations: "20261119_order_confirmation_thread": {operations: [{sql: {up: _confirmThreadSql, onComplete: true}}]}
	state: migrations: "20261119_order_tracking_and_ship_mail": {operations: [{sql: {up: _orderTrackingSql, onComplete: true}}]}
	// The order's machine on machine_clock(), the clock a row machine reads,
	// restated as the emitter writes it.
	state: migrations: "20261121_machine_clock": {operations: [{sql: {up: _machineClockSql, onComplete: true}}]}
	state: migrations: "20261123_br_textbook_min_pages": {operations: [{sql: {up: _brMinPagesSql, onComplete: true}}]}
	// India among the countries an order ships to, and the machine restated
	// to price it in rupees.
	state: migrations: "20261125_print_country_in": {operations: [{sql: {up: _printCountryInSql, onComplete: true}}]}
}

loop: surface: checks: "print-order-migration": {
	verb: "test"
	cmds: ["\(pronto.#Platforms.rule); deno test \(_platformFlags) --allow-read --allow-env --allow-sys=homedir tests/print-order-migration.test.ts"]
	note: "the order keeps the migration production ran, and the payments migration brings a released edge database and a fresh one to the same schema"
}

loop: surface: verbs: "commerce-assets": {
	verb: "generate"
	cmds: ["mise exec -- deno run -A --config checkout-ui/deno.json --frozen checkout-ui/build.ts"]
	note: "Builds the pinned browser checkout hatch before packaging."
}

code: surface: screens: print: paths: checkout: {states: ["ready", "ready"], accepts: ["accept-print-checkout"]}
code: surface: screens: print: paths: delivery: {states: ["ready", "ready"], accepts: ["accept-print-delivery"]}
code: surface: screens: print: paths: vendor: {states: ["ready", "ready"], accepts: ["accept-print-vendor"]}
code: surface: screens: print: paths: shop: {states: ["ready", "ready"], accepts: ["accept-print-shop"]}

_denoImage: "denoland/deno:debian-2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432"
_door:      "http://caddy:8080"

// The compose stack's providers, in every launch ([[commerce/README#Local mode]]):
// effects reach them as bridges, and they reach the door as the real ones reach
// the public origin, so each stays on the default network too.
cluster: surface: targets: {
	// Stripe Checkout: its API, its hosted page at provider.ts's address, which a
	// launch publishes and an acceptance browser maps, and its webhooks.
	"checkout-simulator": bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http: {port: 8080, env: "PORT", host: 30826, publish: environment: "SNAPCARDS_CHECKOUT_HOST_PORT"}
		entrypoint: {
			shell: "nu"
			do:    "exec deno run --no-config --allow-env --allow-net commerce/simulator.ts"
			env: {
				STRIPE_SECRET_KEY:     "simulator"
				STRIPE_WEBHOOK_SECRET: "whsec_simulator"
				WEBHOOK_URL:           {peer: "caddy", port: "http", prefix: "http://", suffix: "/signal/stripe"}
			}
		}
		healthcheck: {port: 8080, path: "/_simulator/health"}
		srcs: globs: ["commerce/simulator.ts", "commerce/provider.ts"]
		dockerfile: {
			from: name: _denoImage
			workdir: "/app"
			copy: [{srcs: ["commerce/simulator.ts", "commerce/provider.ts"], dst: "/app/"}]
			cmd: ["run", "--no-config", "--allow-env", "--allow-net=0.0.0.0:8080,caddy:8080", "simulator.ts"]
		}
		compose: {
			networks: ["default"]
			environment: {
				STRIPE_SECRET_KEY:     "simulator"
				STRIPE_WEBHOOK_SECRET: "whsec_simulator"
				WEBHOOK_URL:           "\(_door)/signal/stripe"
			}
			restart: "on-failure"
		}
	}
	// Prodigi: the API and its callbacks; /_simulator/ on the host for acceptance.
	"prodigi-simulator": bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http: {port: 8080, env: "PORT", host: 30827, publish: environment: "SNAPCARDS_PRODIGI_HOST_PORT"}
		entrypoint: {
			shell: "nu"
			do:    "exec deno run --no-config --allow-env --allow-net commerce/prodigi-simulator.ts"
			env: {
				PRODIGI_API_KEY: "simulator"
				DOOR_URL:        {peer: "caddy", port: "http", prefix: "http://"}
			}
		}
		healthcheck: {port: 8080, path: "/_simulator/health"}
		srcs: globs: ["commerce/prodigi-simulator.ts", "commerce/catalogue.ts"]
		dockerfile: {
			from: name: _denoImage
			workdir: "/app"
			copy: [{srcs: ["commerce/prodigi-simulator.ts", "commerce/catalogue.ts"], dst: "/app/"}]
			cmd: ["run", "--no-config", "--allow-env", "--allow-net=0.0.0.0:8080,caddy:8080", "prodigi-simulator.ts"]
		}
		compose: {
			networks: ["default"]
			environment: {
				PRODIGI_API_KEY: "simulator"
				DOOR_URL:        _door
			}
			restart: "on-failure"
		}
	}
	// Cloudprinter: domestic Brazil spiral flip-deck quotes, orders and CloudSignal webhooks.
	"cloudprinter-simulator": bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http: {port: 8080, env: "PORT", host: 30828, publish: environment: "SNAPCARDS_CLOUDPRINTER_HOST_PORT"}
		entrypoint: {
			shell: "nu"
			do:    "exec deno run --no-config --allow-env --allow-net commerce/cloudprinter-simulator.ts"
			env: {
				CLOUDPRINTER_API_KEY: "simulator"
				DOOR_URL:             {peer: "caddy", port: "http", prefix: "http://"}
				WEBHOOK_URL:          {peer: "caddy", port: "http", prefix: "http://", suffix: "/signal/cloudprinter"}
			}
		}
		healthcheck: {port: 8080, path: "/_simulator/health"}
		srcs: globs: ["commerce/cloudprinter-simulator.ts", "commerce/catalogue.ts"]
		dockerfile: {
			from: name: _denoImage
			workdir: "/app"
			copy: [{srcs: ["commerce/cloudprinter-simulator.ts", "commerce/catalogue.ts"], dst: "/app/"}]
			cmd: ["run", "--no-config", "--allow-env", "--allow-net=0.0.0.0:8080,caddy:8080", "cloudprinter-simulator.ts"]
		}
		compose: {
			networks: ["default"]
			environment: {
				CLOUDPRINTER_API_KEY: "simulator"
				DOOR_URL:             _door
				WEBHOOK_URL:          "\(_door)/signal/cloudprinter"
			}
			restart: "on-failure"
		}
	}
	"mail-simulator": bayt.healthcheck.http & {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http: {port: 8080, env: "PORT"}
		entrypoint: {
			shell: "nu"
			do:    "exec deno run --no-config --allow-env --allow-net commerce/mail-simulator.ts"
			env: MAILPIT_URL: {peer: "mailpit", port: "inbox", prefix: "http://"}
			after: mailpit: "healthy"
		}
		healthcheck: {port: 8080, path: "/_simulator/health"}
		srcs: globs: ["commerce/mail-simulator.ts"]
		dockerfile: {
			from: name: _denoImage
			workdir: "/app"
			copy: [{srcs: ["commerce/mail-simulator.ts"], dst: "/app/"}]
			cmd: ["run", "--no-config", "--allow-env", "--allow-net=0.0.0.0:8080,mailpit:8025", "mail-simulator.ts"]
		}
		compose: {
			networks: ["default"]
			environment: MAILPIT_URL: "http://mailpit:8025"
			depends_on: mailpit: condition: "service_healthy"
			restart: "on-failure"
		}
	}
	// What the record and the alert land in; a launch publishes the inbox.
	mailpit: {
		cmd: "builtin": null
		activate: ""
		"process-compose": activate: "mise x --"
		healthcheck: bayt.healthcheck.#http & {
			port:           8025
			path:           "/livez"
			interval:       "2s"
			start_interval: "200ms"
			start_period:   "10s"
			retries:        15
		}
		expose: {
			inbox: {port: 8025, env: "MAILPIT_INBOX_PORT", host: 30825, publish: environment: "SNAPCARDS_MAILPIT_HOST_PORT"}
			smtp: {port: 1025, env: "MAILPIT_SMTP_PORT"}
		}
		entrypoint: {
			shell: "nu"
			do:    "exec mailpit --listen $'127.0.0.1:($env.MAILPIT_INBOX_PORT)' --smtp $'127.0.0.1:($env.MAILPIT_SMTP_PORT)'"
			dockerfile: {shell: "exec", do: "/mailpit"}
		}
		dockerfile: {
			from: name: "axllent/mailpit:v1.32.0@sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498"
			entrypoint: ["/mailpit"]
		}
		compose: {
			healthcheck: {
				test: ["CMD", "/mailpit", "readyz"]
				interval:       "2s"
				start_interval: "200ms"
				start_period:   "10s"
				retries:        15
			}
		}
	}
}
