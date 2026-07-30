# `crb_index.html` Reference Map

**Purpose:** This is a read-only reference document describing the structure of `crb_index.html` (19,098 lines) as of the current commit. It is for orientation only — nothing in `crb_index.html` was changed, moved, or reformatted to produce this map. Line numbers will drift the next time the file is edited; treat them as a snapshot, not a guarantee.

The file is a single self-contained Apps Script `HtmlService` page: no build step, no bundler, no ES modules. React/ReactDOM/Babel-standalone are loaded from CDN `<script>` tags, and the entire app (all components, all styles) is authored in one `<style>` block and one `<script type="text/babel">` block, transpiled live in the browser.

## File layout at a glance

| Lines | Content |
|---|---|
| 1–17 | `<!DOCTYPE>`, `<head>`, CDN `<script>` tags for React 18.2, ReactDOM 18.2, Babel-standalone 7.23.2 |
| 18–10,495 | `<style>` block — all CSS (~10,477 lines) |
| 10,498–10,501 | `<body>`, opening `<script type="text/babel">` |
| 10,501–19,092 | Application code: constants, utilities, ~39 top-level React components |
| 19,094 | `ReactDOM.render(<App />, document.getElementById('root'))` — the only bootstrap statement |
| 19,095–19,098 | Closing `</script>`, `</body>`, `</html>` |

---

## 1. CSS map (`<style>`, lines 18–10,495)

The stylesheet is **not** cleanly partitioned into "all light-mode rules, then all dark-mode rules." Early sections (through ~line 5413) are light-mode only, followed by one large `body.dark` base-override block, but **every feature added after that point (Rate Card onward) has its light-mode rules and `body.dark` overrides for that same feature placed back-to-back**, appended in the order the feature was built. Treat the ranges below as "where a topic's rules live," not as a strict light/dark split.

| Lines | Section |
|---|---|
| 18–292 | Global reset (`*`, box-sizing) and base `body` typography/background |
| 293–1,857 | Header, patient count pill, admin menu, cumulative-unsigned pill, Provider Day View card system, Pre-visit/Post-visit tab switcher, Billing Day frozen-header stack |
| 1,857–2,200 | Rx (medication) modal, Rx cell/badge styles |
| 2,200–4,280 | Week views (grid, direct-pay banners), claim-status badges/pills, Assistant table, Void Appointment Archive, Billing View base card system, $0-copay strip |
| 4,280–5,413 | General modal shell, Patient Info Modal, CPT Modal redesign, Assistant table cell classes, Tebra status badges, theme-toggle button |
| 5,456–~6,290 | `body.dark` — global dark-mode base variables and overrides for everything above |
| ~6,290–8,742 | Later features, each paired with adjacent `body.dark` overrides: CPT Rate Reference Card, Rate Analysis Panel, Claim Submit Modal, Comm Chat Icon, unread-comments badge, note-status badges, Provider pre/post phase bar, Import Payments FAB, Provider Appointment Modal, Note Board Panel, Claims Ledger |
| 10,046–10,495 | Mobile-web responsive layout — one large `≤768px` section with phone/tablet overrides for every view listed above (explicitly documented in-file as "same GAS web app, no separate build/mobile app") |

---

## 2. JavaScript map (`<script type="text/babel">`, lines 10,501–19,092)

### 2.1 Setup, constants & shared utilities (lines 10,501–10,863)

Not components — shared module-level state and helper functions every component below depends on via plain (non-module) scope.

| Lines | Contents |
|---|---|
| 10,504–10,726 | Static config/data: `PROVIDERS`, `METHODS`, `METHOD_LABEL`/`METHOD_COLOR`, `PLATFORM_MAP`, `CPT_LIST`/`CPT_MAP`/`CPT_RATES`, `PAYMENT_PLATFORMS`, `US_STATES`, `PROV_NPIS`, `CLAIM_PLATFORMS`, `RX_MED_GROUPS`, `DAYS`, `MONTHS`, plus small helpers `fmtRate`, `copyToClipboard`, `isZeroRate` |
| 10,727–10,756 | `TODAY` — an IIFE computing "today" in the clinic's local (ET) timezone once at load |
| 10,757–10,777 | `gsr()` — the single Promise-wrapper around `google.script.run`, used by every component that talks to the Apps Script backend |
| 10,778–10,863 | Comment/chat read-tracking helpers (`getIncomingComms`, `getOutgoingComms`, `hasUnreadComms`, `getSeenInCount`, `markCommsSeen`, `markAllCommsRead`, `isYellowDismissed`, `markCommsReadPersist`, etc.) — localStorage-backed logic that drives the red/yellow/neutral chat-icon states |

### 2.2 Components, in file order

| # | Component | Lines | Size | What it does |
|---|---|---|---|---|
| 1 | `CommChatIcon` | 10,864–10,952 | 89 | Chat-icon button rendered on an appointment row; shows an unread-count badge and opens the comments UI (handles both new comments with `readBy[]` and legacy ones without). |
| 2 | `UnreadDot` | 10,956–10,964 | 9 | Backward-compat shim: renders any lingering `<UnreadDot>` usage as `CommChatIcon` in its red-only, non-interactive state. |
| — | *(utils)* | 10,969–11,029 | — | Date/time & status helpers: `dkey`, `fmtYMD`, `fmtDate`, `fmtShort`, `fmtScrDate`, `addDays`, `weekStart`, `tsClass`. |
| 3 | `TBadge` | 11,030–11,037 | 8 | Small colored badge rendering a Tebra note/sign-status string. |
| — | *(utils)* | 11,042–11,312 | — | Appointment status/ID/normalization helpers: `isVoidAppt`, `isPlaceholderPatient`, `normCpt`, `normName`, `insColor`, `parseTypedDate`, `unsignedToISO`, `filterDisplayUnsigned`, `fmtUnsignedDate`, `methodStatus`, `computeStatus`, `methCls`, `newId`, `newAppt`, `parseInputTime`, `timeToMinutes`, `fmtTime`. |
| 4 | `StatusDot` | 11,313–11,315 | 3 | Tiny colored status dot primitive. |
| 5 | `MobileToolsMenu` | 11,323–11,350 | 28 | Phone-only "🧰 Tools" drop-up button that collapses a view's row of desktop action buttons into one menu on narrow screens. |
| 6 | `UnsignedAlert` | 11,352–11,396 | 45 | Day-view banner listing patients with unsigned notes due before their next visit ("Action Required"). Contains a locally-duplicated `urgCls` helper (see §3). |
| 7 | `UnsignedWeekAlert` | 11,398–11,449 | 52 | Week-view equivalent of `UnsignedAlert`, grouped by date. Also contains a duplicate `urgCls` (see §3). |
| 8 | `SummaryBar` | 11,461–11,526 | 66 | Clickable stat row (Total/Signed/Pending/Paid/etc.) shown at the top of Day views; different stat set for Pre-visit vs Post-visit mode. |
| 9 | `PatientSearch` | 11,528–11,564 | 37 | Type-ahead patient name search box used in the Add-appointment flow. |
| 10 | `CalendarPicker` | 11,566–11,600 | 35 | Month-grid date picker popover. |
| 11 | `CPTModal` | 11,602–11,822 | 221 | Modal for selecting/entering CPT billing codes on an appointment, with quick-combo presets and custom-code entry. |
| 12 | `RxMedModal` | 11,824–11,923 | 100 | Modal for adding/removing prescribed medications on an appointment (dropdown + manual entry). |
| 13 | `AddModal` | 11,925–12,001 | 77 | "New appointment" modal — time, patient, billing method, insurance/payment fields. |
| 14 | `PatientModal` | 12,002–12,369 | 368 | Provider's main per-appointment note/screener modal (PHQ-9/GAD-7/PCL-5 scores, clinical note, comments, checklist). Contains nested helper `RadioRow` (line 12,108). |
| 15 | `DayDirectPayBanner` | 12,376–12,467 | 92 | Provider Day View card summarizing direct-pay cost-share collection status for the day (read-only for providers). |
| 16 | `CommItem` | 12,554–12,562 | 9 | Renders one comment entry (date/time/author + note text) inside a comments list. |
| 17 | `ProviderApptModal` | 12,570–12,814 | 245 | Provider's appointment modal opened from Week View or the 💬 button — bundles comments, Rx, CPT codes, and note-signing. |
| 18 | `NoteBoardPanel` | 12,816–12,950 | 135 | Filterable cross-date/cross-provider board of clinical notes and their signed status. |
| 19 | `ClaimsLedger` | 12,953–13,367 | 415 | Filterable ledger of insurance claims (carrier/status/patient search) with inline editable notes, synced to the backend on blur. |
| 20 | `PatientInfoModal` | 13,373–13,523 | 151 | Read-only patient info popup (screener scores, clinical notes, checklist) opened by clicking a patient name in Provider Day View. |
| 21 | `ProvClaimPill` | 13,530–13,573 | 44 | Collapsible claim-status pill shown in the Provider Day View's status column. |
| 22 | `ProviderView` | 13,575–14,061 | 487 | Top-level Provider Day View — renders the appointment table/cards, wires up all the provider-side modals, and owns the CPT-save → auto-sign-note sequencing logic. |
| 23 | `BestChannelHint` | 14,064–14,091 | 28 | Fetches a "best submission channel" suggestion for a carrier/state from an external local API (`http://192.168.88.178:8000/...`) — see note in §4. |
| 24 | `UnsignedTotalBanner` | 14,149–14,159 | 11 | Banner showing a provider's cumulative outstanding unsigned-note count across all dates. |
| 25 | `WeekView` | 14,161–14,377 | 217 | Provider's 7-day week grid, built from the same active/void appointment split used elsewhere. |
| 26 | `CommentsPopup` | 14,384–14,466 | 83 | Lightweight comments-only modal used from Assistant/Biller week views (send is final — persists immediately, doesn't close). |
| 27 | `AllProviderWeekView` | 14,468–14,708 | 241 | Shared week-grid component used by both Assistant and Billing week views (all providers combined or filtered to one). |
| 28 | `AssistantView` | 14,710–15,052 | 343 | Assistant's Day View table — bulk actions, void/archive handling, add/edit/delete appointments. |
| 29 | `RateCardPanel` | 15,086–15,133 | 48 | Floating reference panel of CPT billing rates with click-to-copy amounts. |
| 30 | `BillingChannelsPanel` | 15,152–15,261 | 110 | Panel for viewing/editing which billing channel (Alma/Headway/Grow/Direct) each patient is on. |
| 31 | `RateAnalysisPanel` | 15,275–15,583 | 309 | Analytics panel breaking down realized billing rates by carrier/state (and optionally by provider). |
| 32 | `ClaimSubmitModal` | 15,590–16,359 | 770 | The largest modal in the file — full claim-submission workflow for direct-pay ("Clinic Submit") appointments: CPT codes, payment entry, claim status, notes. |
| 33 | `DirectPaySection` | 16,361–16,606 | 246 | Billing Day View's collapsible cost-share collection UI (the biller-facing counterpart to `DayDirectPayBanner`). |
| 34 | `BillerApptModal` | 16,617–16,817 | 201 | Biller's appointment modal for non-direct-pay appointments (does not replace `ClaimSubmitModal`). |
| 35 | `PaymentImportPanel` | 16,823–17,166 | 344 | Drag-and-drop CSV/XLSX bulk payment import panel. |
| 36 | `BillingView` | 17,168–17,776 | 609 | Top-level Billing Day View — renders the claim table and wires up every billing modal/panel above. Contains nested helpers `ClaimDayBanner` (17,227), `BRow` (17,259), and `ClaimBadge` (17,303). |
| 37 | `PSearchResult` | 17,778–17,802 | 25 | One result row inside `GlobalSearch`. |
| 38 | `GlobalSearch` | 17,804–17,925 | 122 | App-wide debounced patient/appointment search box with keyboard navigation. |
| 39 | `App` | 17,930–19,092 | 1,163 | Root component: view routing (Provider/Assistant/Billing × Day/Week), all top-level state, the per-appointment save queue, optimistic-update + rollback logic for saves/deletes, sticky-header height sync, Tebra sync triggers, theme toggle, mobile header/drawer layout. Everything else in the file is rendered from here. |

Bootstrap: `ReactDOM.render(<App />, document.getElementById('root'))` at line 19,094.

---

## 3. Duplicated / dead code observations

No commented-out code blocks were found — every multi-line comment run in the file is prose (explanatory notes, several documenting specific past bug fixes with dates), not disabled code. A systematic check for functions referenced only once (i.e., only at their own definition) also came back empty, so there don't appear to be any fully unused named functions.

What *was* found — logic copy-pasted across components rather than shared:

- **`urgCls(n)`** — an identical 1-line urgency-class helper (`n>=3 ? 'u3p' : n===2 ? 'u2' : 'u1'`) is defined separately inside both `UnsignedAlert` (line 11,363) and `UnsignedWeekAlert` (line 11,415). Verbatim duplicate; only used within its own component.
- **Comment-sending logic** — the pattern of building a comment via `buildComment()`, merging it into `comms`, and persisting via `onUpdate` is independently reimplemented (with minor variations — e.g. which state array is treated as the source of truth) in four places:
  - `addComm()` in `PatientModal` (line 12,091)
  - `addComm()` in `BillerApptModal` (line 16,657)
  - `sendComment()` in `ProviderApptModal` (line 12,609)
  - `sendComment()` in `CommentsPopup` (line 14,413)

  The two `sendComment()` versions in particular are nearly line-for-line identical (both merge against `appt.comms` vs local `comms` using the same "whichever is longer wins" rule). None of this is dead — all four are live, called paths — but it is the same behavior maintained in four places, so a future bug fix to comment-sending (of the kind several inline comments in the file describe having happened before) would need to be applied four times.
- **`updMs`** (nested-field state updater) is defined separately in `PatientModal` (line 12,040) and `BillerApptModal` (line 16,652) with slightly different signatures (`(ms,k,v)` vs `(key,subfield,val)`) but the same one-line behavior.

None of the above is unused code — it's working, duplicated code. Flagging per the request, not recommending removal.

**One structural oddity worth a human's attention** (not "dead," but notable): `BestChannelHint` (line 14,064) calls `fetch('http://192.168.88.178:8000/api/best-channel?...')` — a hardcoded, non-HTTPS, private LAN IP address baked into a script that gets deployed as a public Apps Script Web App. This will silently no-op (catch swallows the error) for any user not on that specific local network, and is a mixed-content/HTTP concern if the app is ever served over HTTPS from a context that enforces it.

---

## 4. Notes on a future HtmlService `include()` split (background only — not a plan to act on)

This section is scoped as background for a *future* phase, per the request. Nothing here should be acted on now.

**Current deploy setup:** `Code.js`'s `doGet()` calls `HtmlService.createHtmlOutputFromFile('crb_index')` — a single static file, no templating. Apps Script's usual multi-file pattern (`HtmlService.createTemplateFromFile('index').evaluate()` with `<?!= include('other-file') ?>` scriptlets) requires switching to `createTemplateFromFile(...).evaluate()`. That one-line change in `Code.js` would itself need to happen as part of any split — it's outside `crb_index.html` and is not something this document recommends doing yet.

**Why a naive split is risky here:** everything in the current `<script type="text/babel">` block shares one JS scope — components and constants reference each other as plain top-level `function`/`const` bindings, not module imports/exports. If the JS were split into several files each wrapped in its *own* `<script type="text/babel">` tag, Babel-standalone transpiles each independently, and `const`/`let` declared in one script tag are **not** visible to another (only `function` declarations and `var` leak onto `window` across script tags). Given how heavily this file relies on top-level `const` (all of §2.1's constants, plus `TODAY`), that split would silently break at runtime — exactly the kind of change the "don't restructure" constraint is meant to prevent.

**The safe version of a split:** keep exactly one `<script type="text/babel">` tag in the final rendered page, but assemble its *contents* server-side from several `.html` partial files via `<?!= include(...) ?>` scriptlets, in the same order the code appears today (e.g. `styles.html`, `constants.html`, `utils.html`, `components-small.html`, `modals.html`, `views-provider.html`, `views-assistant.html`, `views-billing.html`, `panels.html`, `app.html`). Because `include()` just concatenates raw text before Babel ever sees it, the browser would receive byte-for-byte the same script it does today — this is reorganizing files in the Apps Script/clasp project, not the runtime.

**What would make it safe to actually do, later:**
1. Cut boundaries only at existing top-level component boundaries (the ones listed in §2.2) — never mid-component.
2. After splitting, mechanically verify correctness by reconstructing the full concatenation (in the same `include()` order) and diffing it against today's `crb_index.html` — it should be identical except for the `include()`/scriptlet lines themselves. There's no test suite to catch a mis-ordered cut, so this diff *is* the safety net.
3. Update `doGet()` to use `createTemplateFromFile(...).evaluate()` and verify the deployed Web App still renders identically before ever touching the note the project is currently deployed as.
4. Test against a separate/staging Apps Script deployment, not the live URL, given there's no automated test suite to catch a regression otherwise.
5. Keep the CSS split (`styles.html`) as the first, lowest-risk step if this is ever staged incrementally — it has no scope/closure concerns at all, unlike the JS.

A "real" module split (separate `<script>` tags, explicit exports, eventually a bundler) is a different and larger undertaking — it would require auditing every cross-component reference individually rather than a mechanical cut-and-diff, and is out of scope for anything described above.

---

## 5. Comment-sending logic — side-by-side comparison

*Added after the CSS/JS map above was written and after two small edits to `crb_index.html` (extracting `BEST_CHANNEL_API_BASE` and consolidating `urgCls`), so line numbers here reflect the file's current state and are a few lines higher than any earlier references to this code elsewhere in this document.*

Four components each implement "take the pending comment note, build a comment object, append it to the comments array, and persist" as their own local function. They are **not** all independent — they split into two identical pairs, differing from each other only in one structural choice (how the component stores its own state) and one consequence of that choice (what gets included in the persisted payload). Validation, comment construction, and error handling are identical across all four.

| | `PatientModal.addComm` (line 12,093) | `BillerApptModal.addComm` (line 16,659) | `ProviderApptModal.sendComment` (line 12,611) | `CommentsPopup.sendComment` (line 14,415) |
|---|---|---|---|---|
| **Validation** | `if (!commNote.trim()) return;` | Identical | Identical | Identical |
| **Comment object built via** | `buildComment(commNote, commTo)` (shared, line 12,493 — not duplicated) | Same | Same | Same |
| **Local state shape** | Single mirrored object `d` (`useState({...appt, scr, scrData, ...})`), updated with `setD` | Single mirrored object `d` (`useState(() => ({...appt}))`), updated with `setD` | Dedicated `comms` array only (`useState(appt.comms \|\| [])`), updated with `setComms` | Dedicated `comms` array only (`useState(appt.comms \|\| [])`), updated with `setComms` |
| **Base array read from** | `d.comms \|\| []` — local mirror only | `d.comms \|\| []` — local mirror only | `(appt.comms \|\| []).length >= comms.length ? (appt.comms \|\| []) : comms` — picks whichever of the prop or local state is longer | Identical "longer wins" comparison against `appt.comms` |
| **Read-receipt race guard** | None — relies entirely on the mount-time `markCommsReadPersist` effect having already folded `readBy` updates into `d.comms` before any send happens | None — same reliance as `PatientModal` | Explicit: the "longer wins" comparison exists specifically so a `readBy` update landing on the `appt` prop after a local send won't get clobbered, and a local send racing ahead of the prop won't get lost either (per the inline comment at the call site) | Identical explicit guard, identical comment rationale |
| **`onUpdate` payload** | `{ ...d, comms: newComms }` — the *entire* local mirror, so every other field the user has touched anywhere else in this modal (screener scores, notes, method-validation fields, etc.) rides along with the comment save | `{ ...d, comms: newComms }` — same pattern, whatever fields `d` accumulates via this modal's own `upd`/`updMs` calls | `{ ...appt, comms: newComms, rxMeds, cpt, out }` — spreads the *original prop* (not a continuously-synced mirror), then explicitly re-adds the three extra pieces of state this component tracks separately | `{ ...appt, comms: newComms }` — spreads the original prop; no extra fields, because this component doesn't track anything besides comments |
| **Function name** | `addComm` | `addComm` | `sendComment` | `sendComment` |
| **Endpoint / backend call** | None directly — calls the `onUpdate` prop | Same | Same | Same |

**All four ultimately go through the same backend path.** None of the four functions calls `gsr()` or `fetch()` itself, and none has any try/catch or error handling of its own — each just invokes the `onUpdate` prop it was given, fire-and-forget, with no `await`. All four `onUpdate` props trace back to the same save/queue/rollback machinery in `App` (§2.2 #39), so there is no endpoint difference between them — the difference is entirely in what each function decides to *pass into* `onUpdate`, and how it decides what to merge as the comments array.

**Net read:** this isn't four independently-drifted copies. It's one two-way fork —

- **`d`-mirror pattern** (`PatientModal`, `BillerApptModal`): near-identical bodies (differ only in comments, not code), full-local-state payload, no race guard.
- **`comms`-array pattern** (`ProviderApptModal`, `CommentsPopup`): near-identical bodies (differ only in whether `rxMeds, cpt, out` are appended to the payload), explicit race guard present in both.

— that happened to get reimplemented per-component rather than factored out once. The one behavioral asymmetry worth flagging on its own: the `d`-mirror pair has no defense against the `readBy` race that the `comms`-array pair explicitly guards against. In practice this is probably safe today (the mount-time effect that folds `readBy` into `d.comms` likely resolves well before a user can type and send a comment), but it's a real, not cosmetic, difference in behavior under a race — not just a difference in code shape. No consolidation or edit has been made; this section is a comparison only, per instructions.
