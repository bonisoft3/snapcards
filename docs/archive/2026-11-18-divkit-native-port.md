# Replacing the Android TWA with a DivKit native port on Android and iOS

Status: built 2026-11-19. Replaces the Android Trusted Web Activity wrapper
(`app.hosted.us_central1.flashcards__trash_362115.twa`) and introduces the iOS app by driving
upstream DivKit (`com.yandex.div:div` `Div2View` on Android, `DivView` on iOS) from
[[../../../../plugins/omnishell/docs/native-hosts|Omnishell's native host]] and a headless JS
engine (`QuickJsOmnishellEngine` on Android, system `JSContext` via
`JavaScriptCoreOmnishellEngine` on iOS).

## Why move off the TWA

The TWA wraps `snapcards.fun` inside Chrome Custom Tabs. That got an installable Play Store
listing out with zero native code, at three ongoing costs:

1. **Cold-boot offline library is empty.** `offline-first-sw.js` caches the HTML entry and
   `_immutable-<sha256>-*` code/styles, while `@mecha/client`'s Electric collections keep synced
   `card_set` and `flashcard` rows in JS memory alone and `/img/*` relies on opportunistic HTTP
   cache. Once Android reclaims the Chrome tab, opening the app offline shows no decks until
   Electric reconnects.
2. **Browser-bound UX seams.** Chrome warm-up latency, Digital Asset Links verification races
   that flash the URL bar, web passkey ceremony friction compared with native
   `CredentialManager` / `ASAuthorizationController`, and no path to an App Store listing on iOS
   (Apple Guideline 4.2 rejects pure website wrappers).
3. **Scroll and gesture ceiling.** Study flips, library shelves, and bottom sheets run on the
   browser compositor rather than `RecyclerView`/`UICollectionView`-backed `Div2View`/`DivView`
   views on the OS UI thread.

Snapcards' application logic is already shaped for a headless engine: all 19 handlers under
`shell/handlers/` (`create_set.js`, `play_select.js`, `localize_content.js`, `delivery_*.js`,
and the chart guards) are pure `{ context, event }` functions with zero DOM imports, `ai-browser`
runs a pure-JS lexicon (`MODEL_ENABLED = false`), and the app uses no Web Audio or Web Speech
APIs.

## Shortcomings in the current stack

### 1. Authentication

Six protocol and store assumptions in `libraries/mecha/services/auth/` and `mecha-edge` break
outside a browser tab:

- **Android WebAuthn `expectedOrigin` mismatch.** `services/auth/main.ts` and
  `packages/mecha-edge/src/cluster.ts` pass a single `expectedOrigin` (`https://snapcards.fun`)
  to `@simplewebauthn/server`. On iOS (`ASAuthorizationPlatformPublicKeyCredentialProvider`),
  once `/.well-known/apple-app-site-association` declares `webcredentials`, `clientDataJSON.origin`
  is `https://snapcards.fun`. On Android (`androidx.credentials.CredentialManager`), the OS
  writes `android:apk-key-hash:<base64url-sha256>` as the origin. Both auth verifiers must
  accept an allowlist of origins (`ORIGIN` plus configured `ANDROID_APK_KEY_HASHES`), and
  `snapcards.fun/.well-known/assetlinks.json` must add
  `delegate_permission/common.get_login_creds` alongside `handle_all_urls`.
- **OIDC cookie-jar isolation.** `services/auth/oidc.ts` ends `/auth/oidc/<provider>/callback`
  by setting an `HttpOnly; SameSite=Lax` cookie (`mecha_oidc`) in the browser and redirecting to
  `/`, while the Ory Hydra broker ([[../../../../plugins/pronto/docs/identity|Identity]]) admits
  only `<origin>/auth/oidc/<provider>/callback` as `redirect_uri`. Neither
  `ASWebAuthenticationSession` (iOS) nor Chrome Custom Tabs (Android) shares cookies with
  `OkHttp` / `URLSession`. Adding `?return=native&code_challenge=<S256>` on
  `/auth/oidc/<provider>/start` lets `/callback` mint a 60-second single-use PKCE-bound ticket
  and redirect to `snapcards://auth/callback?ticket=<code_id>`, which the native engine redeems
  at `POST /auth/oidc/session` for `{ token, user }`.
- **Non-renewable 7-day JWTs orphan guest UGC.** `USER_TOKEN_TTL_S` is 7 days with no refresh
  token, and web `shell.js` stores `pronto-token` in tab-ephemeral `sessionStorage`. On mobile,
  a guest reopening the app on day 8 would mint a fresh `POST /auth/guest` UUID — losing
  ownership of every deck created in week 1 — and signed-in accounts would be logged out weekly.
  Tokens must live in iOS Keychain / Android Keystore (`EncryptedSharedPreferences`) paired with
  a rotating refresh token (`POST /auth/refresh`) for both guest and promoted/linked accounts.
- **App Store Guideline 4.8 (Sign in with Apple) and Guideline 5.1.1(v) (Account deletion).**
  Offering Google OIDC on iOS requires offering Sign in with Apple as an equivalent option
  (Passkeys alone are a W3C/OS credential and do not trigger 4.8). Both Apple (5.1.1(v)) and
  Google Play Data Safety also require in-app account deletion (`DELETE /auth/account` cascading
  owned credentials and private rows, wired into the account sheet).
- **Guest-to-OIDC promotion.** Registering a passkey with a guest Bearer token (`promote: true`)
  preserves `app_user.id` and all owned decks; signing in via OIDC currently switches `sub` and
  leaves guest decks behind. Accepting an optional guest Bearer token on `/auth/oidc/<provider>/start`
  so a newly linked `app_user` adopts the guest's `card_set` and `flashcard` rows keeps the two
  sign-in paths consistent.
- **Offline first boot.** If a fresh install boots without signal, `POST /auth/guest` cannot run
  yet. Minting a provisional client UUID locally (or re-binding uncommitted `subject: null`
  outbox transactions once `/auth/guest` resolves) avoids stranding decks created on an offline
  first launch.

### 2. Offline UGC and TanStack DB on SQLite

[[../../../../plugins/omnishell/docs/data|Omnishell's store]] (`interpreter/data-sync.js`) pairs
`@tanstack/db` + `@tanstack/electric-db-collection` with `@tanstack/offline-transactions` in
`@mecha/client`:

- **What carries over unchanged.** Creating a deck offline runs `create_set.js` in QuickJS/`JSContext`,
  synthesizes Level-1 words and inline SVG placeholders, applies optimistic rows into `card_set`,
  `flashcard`, and `generation_draft`, settles the UI promise in 2.5 s (`ACCEPT_MS`), and queues
  idempotent `Idempotency-Key` mutations. On reconnect, queued mutations flush to Postgres,
  `confirmWrite` awaits `awaitTxId(x-txid)` on the Electric stream before dropping the
  optimistic overlay, and server-side drains kick off Airlock (`smollm3-draft` → `heavy-draft` →
  `illustrate-card` → R2) without holding the phone awake.
- **Four gaps to close on native:**
  1. *SQLite storage adapters:* `packages/client/src/storage.ts` checks
     `typeof indexedDB !== "undefined"` and falls back to `MemoryStorageAdapter` when absent;
     `device` collections (`device`, `generation_form`, `delivery_draft`) read `localStorage`.
     Both must bind to `StorageBridge` (`SqliteKeyValueStore` / SQLite outbox table) so queued
     offline writes and drafts survive process death.
  2. *Cold-boot Electric snapshots and `/img/*` cache:* Persist compacted Electric shape rows and
     stream offsets (`offset`, `handle`) per table in SQLite so cold-starting offline hydrates
     `card_set`, `flashcard`, and `deck_translation` before the network answers, paired with a
     bounded `OkHttp` / `URLCache` disk cache for `/img/*` card art.
  3. *Client-stamped `owner`:* `create_set.js` omits `owner` on `card_set` and `flashcard`
     inserts, relying on Postgres `DEFAULT auth_uid()`. Stamping `owner: meId` client-side makes
     offline-created decks appear in `/mine` and pass local owner guards (`deckRow.owner === meId`)
     before the server round-trip.
  4. *`Favorite` durability:* `Favorite` in [[../../program.cue]] is `durability: "server"`
     (`requestOnly`), bypassing TanStack DB and failing offline. Moving `Favorite` to
     `durability: "offline"` puts heart toggles onto the optimistic outbox.

### 3. Code and UI updates: running Omnishell's SWR worker in QuickJS / JSC

Both Google Play's *Device and Network Abuse* policy and Apple's Developer Program License
Agreement §3.3.1(B) explicitly allow downloading interpreted JavaScript executed inside a
sandboxed interpreter (`QuickJsOmnishellEngine` on Android, Apple's built-in `JSContext` without
JIT on iOS) when native OS APIs are reached only through fixed, pre-reviewed bridges (`fetch`,
`sql`, `kv`, `emitUiAst`) and the app's core purpose does not change.

Rather than inventing a second OTA protocol, the native port reuses
[[../../../../plugins/pronto/docs/decisions/2026-10-16-releases-by-content|Releases by content]] and
[[../../../../plugins/omnishell/docs/screen-updates|Screen updates]] verbatim:

- **`offline-first-sw.js` runs directly in QuickJS / `JSContext`.** The 100-line worker uses only
  `fetch`/`Request`/`Response`/`Headers`, `self.location.origin`, `addEventListener`, and five
  `CacheStorage` methods (`caches.open`, `keys`, `delete`, `match`, `put`). Implementing
  `CacheStorage` over `StorageBridge` on disk lets `offline-first-sw.js` wrap engine `fetch`
  with zero Chromium `WebView` overhead (while `Div2View`/`DivView` image loaders fetch `/img/*`
  on native threads).
- **Cold install is a `pronto-kept` boot.** Packaging pre-seeds `pronto-entries-v1` (already
  stamped `<meta name="pronto-kept">`) and `pronto-addressed-v1` from bundled `assets/`. First
  launch paints immediately offline from bundled bytes, revalidates the entry in the background,
  and runs `shell.js`'s existing post-boot `heed()` + `planRelease()` once booted, deferring
  while `editing()` is true.
- **One `#pronto-assets` map on `https://snapcards.fun`.** Build-time `addressRelease` includes
  `_immutable-<sha256>-<screen>.divkit.json` and `"/@native/bridge": "/_immutable-<sha>-bridge"`
  in `#pronto-assets`, plus an Ed25519 signature verified against a public key pinned in the
  binary:
  - *`morph` (`DivKit JSON`, tokens, `/messages/*.json`, existing pure handlers):* applied in
    place via `Div2View.setData` / `DivView` keyed diffing while preserving scroll and
    `DivVariableController` / `DivVariableStorage` input values.
  - *`restart` (shared JS runtime, statecharts, new handlers, with `"/@native/bridge"` unchanged):*
    snapshots dirty inputs and `tab` rows, purges `pronto-entries-v1`, and reboots the
    QuickJS/`JSContext` isolate in ~15 ms without recreating the host `Activity`/`UIViewController`.
  - *Bridge change (`"/@native/bridge"` moved):* keeps running the coherent cached release
    (served by `retainReleases`) and triggers Google Play In-App Updates / App Store update
    prompt when Kotlin/Swift bridges change.

### 4. Host SDKs, projection, and `/print`

- **Real DivKit SDKs and async iOS fetch.** `plugins/omnishell/android` and `ios` currently
  validate DivKit JSON in memory without linking `com.yandex.div:div` or `divkit-ios`, and
  `JavaScriptCoreOmnishellEngine.swift` blocks its serial `JSContext` queue synchronously inside
  `__nativeFetch` (which would deadlock Electric long-poll / SSE). `fetch` on iOS must become
  callback/promise-driven over `URLSession`.
- **Compiler and runtime loop (`project-native.ts`).** Upgrade `project-native.ts` + headless
  screen binding to lower `[data-image-src]` (`div-image` + SVG data-URI decoding for Level-0
  cards), `[popover]` and modal sheets (`div-state`), CSS `[data-status]` / `[data-flipped]`
  state rules, visibility expressions replacing `:has(.owned-deck)` and `:has(.fav-count-probe)`,
  dynamic `data-live` repeater stamping, row statecharts (`cardsRows`, `cardRows`, `exploreRows`,
  `generateRows`, `printRows`), and one small `div-custom` `flip-card` container (`rotationY` +
  camera distance on Android; `CATransform3DMakeRotation` on iOS).
- **`/print` Studio (`print-checkout`, `delivery-map`, `window-print`).** Six of seven screens
  (`cards`, `generate`, `explore`, `deck`, `card`, `about`) project cleanly to pure DivKit.
  `/print` depends on `@page` / `@media print` pagination, `OffscreenCanvas` 300 DPI postcard
  JPEG composition (`checkout-ui/artwork.ts`), MapLibre GL (`delivery-map`), and Stripe Checkout
  ([[../../commerce/README|Print commerce]] — physical goods, exempt from Google Play Billing and
  Apple IAP). Mounting `/print`'s sheet/map surface in a scoped `div-custom` `WebView` /
  `WKWebView` `realm` hatch wired to `PrintManager` / `UIPrintInteractionController`, and opening
  Stripe Checkout in Custom Tabs / `ASWebAuthenticationSession` (`snapcards://print/return`),
  ships full print and Prodigi ordering without rewriting 3,000 lines of layout and canvas code
  per OS.

## Two-sprint plan

### Sprint 1: Native hosts, auth, SWR updates, and core study/create loop (6 screens)

**Exit criteria:** Physical Android and iOS builds rendering `Div2View` / `DivView`, passing
Passkey + OIDC + renewable Guest auth against staging/production, updating OTA via
`offline-first-sw.js` + `planRelease`, and running `cards`, `generate`, `explore`, `deck`,
`card`, and `about` online and cold-boot offline.

1. **Auth and domain association (Mecha + edge):**
   - Accept `ANDROID_APK_KEY_HASHES` alongside `ORIGIN` in `services/auth/main.ts` and
     `mecha-edge/src/cluster.ts`; publish `get_login_creds` in `assetlinks.json` and
     `webcredentials` + `applinks` in `apple-app-site-association`.
   - Add `?return=native` PKCE ticket handoff (`snapcards://auth/callback?ticket=...`) and
     guest-deck adoption on OIDC sign-in in `services/auth/oidc.ts`.
   - Add `POST /auth/refresh` (Keychain / Keystore storage) and `DELETE /auth/account`.
2. **Android AAR + iOS Swift package + SWR worker:**
   - Convert `plugins/omnishell/android` to an Android library linking `com.yandex.div:div`,
     `quickjs-android`, `OkHttp`, and `Coil` (`coil-svg`); link `divkit-ios` + SVG decoding in
     `plugins/omnishell/ios` and make `JavaScriptCoreOmnishellEngine` `fetch` asynchronous.
   - Implement `AuthBridge` (`CredentialManager` + Custom Tabs; `ASAuthorizationController` +
     `ASWebAuthenticationSession`), disk `CacheStorage` for `offline-first-sw.js`, Ed25519
     manifest verification, and `.divkit.json` + `"/@native/bridge"` emission in
     `release-addresses.ts`.
3. **Headless Omnishell runtime, projection, and SQLite offline UGC:**
   - Back `@mecha/client` outbox, `device` collections, and compacted Electric shape snapshots
     with `StorageBridge` SQLite; stamp `owner: meId` in `create_set.js`; switch `Favorite` to
     `durability: "offline"`.
   - Extend `project-native.ts` and headless screen reconciliation for `data-live` lists, row
     statecharts, `data-on-mutation` folds, `div-image`, `div-state` sheets, and the `div-custom`
     3D `flip-card` block.

### Sprint 2: `/print` + Prodigi commerce, store compliance, CI packaging, and submission

**Exit criteria:** Full `/print` parity (Print at Home, Print Shop PDF, Prodigi + Stripe),
automated `saytw` native builds, TestFlight external beta, and Google Play TWA upgraded in place
to the DivKit AAB.

1. **`/print` hatch and native print/payment bridges:**
   - Add the scoped `div-custom` `WebView` / `WKWebView` `realm` adapter for `delivery-map`
     (bridging OS geolocation permissions) and 300 DPI `artwork.ts` / `@media print` sheets.
   - Connect `#btn-window-print` to Android `PrintManager` and iOS `UIPrintInteractionController`;
     route Prodigi Stripe Checkout through Custom Tabs / `ASWebAuthenticationSession` returning
     to `snapcards://print/return`.
2. **Store review compliance and responsive/RTL polish:**
   - Add Sign in with Apple to the Hydra broker (`id.bonisoft3.com`) so iOS offers Passkey,
     Apple, and Google together (Guideline 4.8); expose Delete Account in the avatar bottom
     sheet (Guideline 5.1.1(v) and Play Data Safety).
   - Verify Phone (`< 768dp`) 3-CTA + Avatar sheet, Tablet/iPad (`>= 768dp`) `88dp` rail +
     2-column grid, `light-dark()` theme switching, and `he` RTL alignment.
3. **Pronto build/release targets and store rollout:**
   - Emit Gradle/Xcode projects with pre-seeded `pronto-entries-v1`, `pronto-addressed-v1`, and
     `derived.sql` from `saytw build@android` / `build@ios`, keeping application ID
     `app.hosted.us_central1.flashcards__trash_362115.twa` and the existing Play App Signing
     certificate so installed TWA users upgrade seamlessly in place.
   - Run emulator/simulator journey checks in CI, ship to TestFlight and Play Internal Testing,
     verify live OTA `morph` and isolate `restart` against `saytw 'release@production'`, and
     promote.

## Rejected

- **Keeping the TWA and adding an iOS `WKWebView` wrapper.** Violates Apple Guideline 4.2 on iOS
  and leaves Android cold-boot offline empty once the browser tab is evicted.
- **Hand-writing Kotlin Compose and SwiftUI screens.** Breaks single-source compile-time
  verification across `program.cue`, `screen-machines.cue`, and `screens/*.html`
  ([[../../../../plugins/omnishell/docs/native-hosts#rejected|Native hosts]]).
- **Running Chromium's `ServiceWorkerController` in a hidden `WebView` just for SWR.** Pays
  ~100 MB RAM and ~300 ms startup on Android and cannot intercept `JSContext` / `URLSession`
  requests on iOS, whereas `offline-first-sw.js` needs only a 5-method disk `CacheStorage` in
  QuickJS / `JSContext`.
- **Splitting OTA into SDUI-only and shipping Store binaries for every JS handler change.**
  Unnecessary under both stores' interpreted-code rules and sacrifices `saytw 'release@production'`
  velocity; `"/@native/bridge"` reserves binary releases strictly for Kotlin/Swift bridge changes.
- **Rewriting `@page` print layout, 300 DPI canvas composition, and MapLibre natively in Sprint 1.**
  A scoped `div-custom` `realm` WebView on `/print` ships identical print fidelity on schedule
  while keeping every browsing, creation, and study screen 100% native DivKit.
