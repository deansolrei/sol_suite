# `Code.js` Reference Map

**Purpose:** Read-only reference document describing the structure of `Code.js` (6,893 lines) as of the current commit. Nothing in `Code.js` was changed, moved, or reformatted to produce this map — line numbers are a snapshot and will drift the next time the file is edited.

`Code.js` is the Apps Script backend for SolBoard: plain server-side JavaScript (V8 runtime, `function` declarations, no ES modules, no build step, no Babel/JSX — that only applies to the frontend, `crb_index.html`), deployed by pasting the whole file into the Apps Script editor and redeploying. There is no automated test suite; the many `test*`/`debug*` functions in this file are manual, run-from-the-editor diagnostics, not an automated suite.

**Methodology note on "callers":** call counts below were computed by searching the file text for `functionName(` after stripping comments, plus cross-referencing every `gsr('functionName', ...)` call in `crb_index.html` (the only mechanism the frontend uses to reach the backend — confirmed there's no other `google.script.run` call pattern). This catches real code calls but can't see two things: (1) Apps Script **triggers** (time-driven or spreadsheet-edit triggers), whose configuration lives in the Apps Script project's Triggers UI, not in this file's source — a function bound to a trigger will look uncalled by this method; (2) a function name mentioned only inside a `Logger.log(...)` string telling a human operator "run X to diagnose" — that's an instruction to a person, not a real call, but naive text-matching can't always tell the difference. Both are called out explicitly below wherever relevant, rather than being silently flattened into "dead code."

---

## 1. Function map, grouped by purpose

128 top-level functions total. Names prefixed `_` are the file's own convention for "internal helper, not meant to be run standalone from the Apps Script editor."

### 1.1 Web app entry & one-time setup

| Function | Lines | What it does |
|---|---|---|
| `_sv` | 156–158 | Safe string conversion that preserves numeric `0` (plain `String(v\|\|'')` would turn `0` into `''`). |
| `doGet` | 164–170 | The Apps Script Web App entry point — Google's runtime calls this automatically on every page load; serves `crb_index.html` via `HtmlService`. Never called by name anywhere in source. |
| `initializeSheets` | 176–261 | One-time setup: creates the Appointments/Patients/Audit Log/Staff tabs, writes headers, seeds the Staff roster from `STAFF_SEED`. Run once from the editor per the file's own deploy instructions. |
| `styleHeaderRow` | 263–266 | Shared helper: applies header-row background/foreground colors and freezes row 1. Called by `initializeSheets`, `updateSheetHeaders`, `generateRateAnalysis`, and `generateProviderRateAnalysis`. |
| `getLogoBase64` | 272–283 | Reads `LOGO_FILE_ID` from Google Drive and returns the logo as a base64 string. **No callers found anywhere — see §4.** |

### 1.2 Appointment CRUD (called from `crb_index.html` via `gsr()`)

| Function | Lines | What it does |
|---|---|---|
| `getAppointments` | 290–368 | Returns one provider's appointments for a single date. |
| `getWeekAppointments` | 370–458 | Returns one provider's appointments across a 7-day week. |
| `getAllWeekAppointments` | 461–548 | Returns all providers' appointments across a 7-day week (used by Assistant/Billing week views). |
| `searchPatient` | 555–598 | Backs `GlobalSearch` — searches patients/appointments by name. |
| `saveAppointment` | 605–722 | Full-row upsert of an appointment — the main save path used throughout the app. |
| `signNoteAndClearUnsigned` | 778–820 | Marks a note signed and removes its date from the appointment's unsigned-dates list. |
| `clearPhantomUnsignedDate` | 834–916 | Removes a single stale/phantom entry from an appointment's unsigned-dates list without touching anything else. |
| `getTotalUnsignedCount` | 979–1037 | Computes a provider's cumulative outstanding unsigned-note count across all dates (backs `UnsignedTotalBanner`). |
| `deleteAppointment` | 1645–1674 | Deletes an appointment row. |

### 1.3 Internal status / date normalization helpers

| Function | Lines | What it does |
|---|---|---|
| `_toUnsignedDateStr` | 725–751 | Normalizes a raw unsigned-date cell value (Date object, string, etc.) to a consistent string form. |
| `_normName` | 774–776 | Normalizes a patient name for case/whitespace-insensitive comparison. |
| `_isVoidStatus` | 932–940 | Classifies a Tebra status string as void (No-show / Rescheduled / Cancelled / Deleted in Tebra). |
| `_normalizeStatusWord` | 963–965 | Normalizes status-string casing/spacing before classification. |
| `_isConfirmedStatus` | 966–968 | Classifies a status string as "Confirmed." |
| `_isCheckedOutStatus` | 969–972 | Classifies a status string as "Checked Out." |
| `_visitOccurred` | 975–977 | Determines whether a visit actually occurred, based on status. |
| `_normalizeDateStr` | 1607–1638 | Normalizes a date value to a canonical `YYYY-MM-DD` string. |

### 1.4 Unsigned-notes auditing & maintenance (manual, run from the Apps Script editor)

| Function | Lines | What it does |
|---|---|---|
| `auditUnsignedNotes` | 1075–1252 | Read-only audit (v1) of unsigned-note state across the sheet; logs findings, changes nothing. |
| `auditUnsignedNotesV2` | 1280–1431 | Read-only audit (v2) — see §3/§4 for its relationship to v1. |
| `reconcileAllCheckedOutSigned` | 1454–1517 | One-time fix: marks appointments that are Checked-Out but not yet flagged signed. |
| `cleanupCorruptedStatusColumn` | 1542–1602 | One-time fix for a specific corrupted-status-column bug (per its header comment, tied to a specific historical incident). |
| `debugUnsignedNotes` | 4799–4830 | Manual debug dump of unsigned-notes state for troubleshooting. |
| `repairUnsignedColumn` | 4912–4941 | One-time fix for malformed Unsigned-column values. |

### 1.5 Patient management

| Function | Lines | What it does |
|---|---|---|
| `getPatients` | 1681–1716 | **FE-called.** Returns the full Patients tab. |
| `getPatientCountsByProvider` | 1730–1763 | **FE-called.** Patient counts grouped by provider. |
| `cleanupPlaceholderPatients` | 1789–1821 | Manual: removes calendar-block "placeholder patients" (per `PLACEHOLDER_PATIENT_NAMES`) that leaked into the Patients tab. |
| `_cleanupPlaceholdersFromSheet` | 1829–1863 | Internal helper shared by `cleanupPlaceholderPatients`: does the actual row-scrubbing for one sheet. |

### 1.6 Note board & claims ledger (FE-called)

| Function | Lines | What it does |
|---|---|---|
| `getNoteBoard` | 1874–1919 | Cross-date/cross-provider clinical note board data. |
| `saveNoteStatus` | 1927–1949 | Saves a note-signed status change from the Note Board panel. |
| `getClaimsLedger` | 1959–2060 | Claims ledger data (carrier/status/patient-filterable). |
| `saveClaimNotes` | 2068–2090 | Saves a biller's freeform notes on a claim. |

### 1.7 Auth / role / access (internal)

| Function | Lines | What it does |
|---|---|---|
| `getCurrentUserWithRole` | 2097–2111 | **FE-called.** Resolves the logged-in Google account to `{email, role, provID, displayName}` via the Staff tab. |
| `_apptSheet` | 2118–2120 | Returns the Appointments sheet object. **No callers found — see §4.** |
| `_getStaffRecord` | 2122–2134 | Looks up a Staff-tab row by email. |
| `_checkProvAccess` | 2136–2148 | Role/provider access-check helper. |

### 1.8 Row ⇄ object conversion & small formatting helpers (internal)

| Function | Lines | What it does |
|---|---|---|
| `_nb` | 2150–2154 | Normalizes a boolean-like cell value. |
| `_fmtDate` | 2156–2166 | Formats a date for sheet storage/display. |
| `_fmtTime` | 2168–2181 | Formats a time for sheet storage/display. |
| `_normalizeTimeKey` | 2183–2195 | Normalizes a time string into a consistent lookup key. |
| `rowToAppt` | 2197–2270 | Converts a raw sheet row array into an appointment object (the read-side counterpart to `apptToRow`). |
| `apptToRow` | 2272–2341 | Converts an appointment object into a raw sheet row array for writing. |
| `_isValidUSState` | 2355–2357 | Validates a 2-letter US state code. |
| `_lookupPatient` | 2367–2396 | Looks up a patient's insurance/state by name from the Patients tab. |
| `_audit` | 2398–2411 | Writes one entry to the Audit Log tab. |

### 1.9 Tebra API integration — production import pipeline

| Function | Lines | What it does |
|---|---|---|
| `importFromTebraApi` | 3580–4250 | **FE-called.** The real, current Tebra→Sheets sync — the main production import pipeline (671 lines, the largest function in the file). |
| `_fetchTebraAppointments` | 3418–3542 | Fetches appointments from the Tebra SOAP API for a date range. |
| `_fetchTebraAppointmentsChunked` | 3544–3578 | Same as above, chunked across sub-ranges (for wide date spans). |
| `_fetchServiceLocationMap` | 3334–3415 | Fetches Tebra's service-location list and builds a location→state map. |
| `_extractStateFromLocationName` | 3304–3325 | Parses a US state out of a Tebra service-location name string. |
| `_buildPatientLookup` | 4374–4438 | Builds a name→patient-record lookup map from the Patients tab. |
| `deduplicateAppointments` | 4644–4759 | Manual: removes duplicate appointment rows (idempotent, safe to re-run per its own comment). |
| `repairTimeColumn` | 4441–4468 | One-time fix for malformed Time-column values. |
| `_matchTebraProvider` | 2717–2724 | Maps a Tebra `ResourceName1` string to a CRB provider key via `TEBRA_PROVIDER_MAP`. |

### 1.10 Tebra API low-level SOAP/XML plumbing (internal)

| Function | Lines | What it does |
|---|---|---|
| `_isTebraApiEnabled` | 2673–2677 | Reads the Tebra-API-enabled flag from Script Properties. |
| `getTebraApiStatus` | 2680–2682 | **FE-called.** Exposes that flag to the frontend. |
| `setTebraApiEnabled` | 2685–2693 | **FE-called.** Toggles that flag. |
| `_getTebraCreds` | 2752–2759 | Reads Tebra API credentials from Script Properties (see §2 — not hardcoded). |
| `_xmlEscape` | 2761–2768 | Escapes XML special characters for building SOAP request bodies. |
| `_tebraHeader` | 2770–2776 | Builds the shared `RequestHeader` XML fragment (credentials + client version) used in every SOAP call. |
| `_tebraPost` | 2778–2810 | POSTs a SOAP envelope to `TEBRA_ENDPOINT` and returns the raw response text. |
| `_tebraDateFmt` | 2812–2814 | Formats a `Date` for the Tebra API's expected date format. |
| `_parseYMD` | 2816–2819 | Parses a `YYYY-MM-DD` string into a `Date`. |
| `_parseTebraStartDate` | 2853–2880 | Parses a Tebra appointment's combined start date+time into a usable value. |
| `_titleCase` | 2882–2887 | Title-cases a string (patient/provider name formatting). |
| `_stripMiddleName` | 2908–2915 | Strips a middle name/initial from a full name for matching. |
| `_samePatient` | 2923–2929 | Compares two patient names for equality (name-matching helper). |
| `_findXmlElements` | 2931–2936 | Regex-based extraction of all matches of an XML element from a response string. |
| `_findFirstXml` | 2939–2943 | Regex-based extraction of the first match of an XML element. |
| `_getXmlChildText` | 2945–2951 | Extracts a child element's text content from an XML node string. |

### 1.11 Tebra test / debug scripts (manual, run from the Apps Script editor — not called from anywhere else by design)

| Function | Lines | What it does |
|---|---|---|
| `checkTebraCreds` | 2736–2750 | Verifies Tebra credentials are set in Script Properties. |
| `testTebraConnection` | 2954–2978 | Basic Tebra API connectivity smoke test. |
| `testTebraStatusFetch` | 2985–3012 | Tests fetching appointment status values from Tebra. |
| `testTebraProviders` | 3020–3084 | Tests/lists Tebra provider records. |
| `testTebraWsdl` | 3092–3114 | Fetches and inspects the Tebra WSDL. |
| `testTebraFindInsuranceField` | 3124–3170 | Probes the WSDL for insurance-related field names. |
| `testTebraPatientCaseFields` | 3180–3229 | Probes patient-case field names. |
| `testTebraGetAppointments` | 3256–3295 | Tests the `GetAppointments` Tebra call directly. |
| `testTebraGetPatients` | 5977–6005 | Tests the `GetPatients`/`GetAllPatients` Tebra call. |
| `testTebraGetPatientsRaw` | 6015–6068 | Same, but dumps the raw XML response for inspection. |
| `testPatientAuth_Try1_ClientVersion` | 6082–6109 | Auth-troubleshooting attempt #1 (`GetAllPatients` + explicit `ClientVersion`). See §3 for duplication with #2/#3. |
| `testPatientAuth_Try2_GetPatients` | 6116–6146 | Auth-troubleshooting attempt #2 (`GetPatients` instead of `GetAllPatients`). |
| `testPatientAuth_Try3_WithPracticeID` | 6152–6185 | Auth-troubleshooting attempt #3 (adds explicit `PracticeID` filter). |
| `testServiceLocationFields` | 6199–6328 | Probes two approaches for getting service-location data from `GetAppointments`. |
| `testServiceLocationNames` | 6331 | One-line legacy alias for `testServiceLocationFields`, explicitly "kept so any saved triggers still resolve" per its own comment. |
| `debugImportMay12` | 4519–4524 | One-off debug import for a specific historical date. |
| `debugTebraStatusForProvider` | 4851–4910 | Debug dump of Tebra status values for one provider. |
| `diagnoseNewPatient` | 4958–5081 | Traces why a specific named patient isn't matching/importing correctly. |
| `runDiagnoseNewPatient` | 5088–5090 | Convenience wrapper — edit the name inside and run. |

### 1.12 Tebra sync — scheduled / trigger / manual run wrappers

| Function | Lines | What it does |
|---|---|---|
| `fullSyncTebraApi` | 4568–4586 | **FE-called** ("Full/Nuclear Sync" button) — broad-range sync (last 90 days → +8 weeks per the frontend map). |
| `overnightSyncTebraApi` | 4594–4628 | No in-file caller and not FE-called — name and behavior (broad nightly-style sync) strongly suggest this is bound to a time-driven trigger configured outside this file. Cannot be confirmed from source alone (see Methodology note). |
| `runTebraApiImportToday` | 4506–4512 | Manual/trigger wrapper — imports today only. |
| `runTebraApiImportThisWeek` | 4526–4541 | Manual/trigger wrapper — imports the current week. |
| `runTebraApiImportEightWeeks` | 4543–4560 | Manual/trigger wrapper — imports an 8-week window. |
| `runTebraApiImportDryRunThisWeek` | 4762–4790 | Manual dry-run variant of the current-week import. |
| `clearTebraApiImports` | 4471–4503 | Manual: clears imported-appointment tracking state (presumably to force a clean re-import). |

### 1.13 One-off migration & backfill scripts (manual, run from the Apps Script editor)

| Function | Lines | What it does |
|---|---|---|
| `backfillPatientStatesFromTab` | 4264–4326 | Backfills blank `PatientState` values by reading the Patients tab directly (dynamically locates the column so it's layout-independent). |
| `cleanBadPatientStates` | 4337–4371 | Clears invalid `PatientState` values as a precursor to re-running the backfill. |
| `_fetchTebraPatientStates` | 5604–5692 | Internal: fetches all patients' states directly from Tebra (used by the sync/backfill functions below). |
| `backfillInsuranceCarrier` | 5715–5787 | Backfills the `InsuranceCarrier` column from `DirectIns`; `forceOverwrite` param controls blanks-only vs. overwrite-all. |
| `runBackfillInsuranceCarrier` | 5793–5797 | Manual wrapper — blanks only. |
| `runBackfillInsuranceCarrierForce` | 5804–5808 | Manual wrapper — force-overwrite all. |
| `syncPatientStates` | 5827–5948 | Syncs the `PatientState` column from a Tebra patient map (live-fetched or passed in); same blanks-only/force pattern. |
| `runSyncPatientStates` | 5954–5958 | Manual wrapper — blanks only. |
| `runSyncPatientStatesForce` | 5964–5968 | Manual wrapper — force-overwrite all. |
| `migrateAddPatientClaimCols` | 5320–5349 | Adds any missing `PATIENT_COLS` header columns to the Patients tab; safe to re-run. |
| `renameHeadersForTerminologyCleanup` | 5389–5448 | One-time: renames sheet headers to match a terminology change (e.g. ClaimPlatform → ClaimGateway). |
| `updateSheetHeaders` | 3236–3254 | Maintenance: syncs the Appointments sheet's header row to `APPT_COLS` after the constant grows. |
| `bulkVerifyQ1_2026_dryRun` | 5472 | One-line manual wrapper: dry-run bulk-verify over Q1 2026. |
| `bulkVerifyQ1_2026` | 5473 | One-line manual wrapper: live bulk-verify over Q1 2026 — calls `_bulkVerifyRange` (so it's not itself an orphan, even though nothing calls it in turn). |
| `_bulkVerifyRange` | 5475–5570 | Internal: shared date-range bulk-verify implementation used by both wrappers above. |

### 1.14 Legacy import pathway (superseded — see §4)

| Function | Lines | What it does |
|---|---|---|
| `runTebraImport` | 2420–2427 | Manual: runs `importTebraAppointments` against `TEBRA_IMPORT_SHEET_ID`. |
| `runTebraImportDryRun` | 2429–2442 | Same, dry-run. |
| `importTebraAppointments` | 2444–2651 | Imports from an **already-exported Tebra spreadsheet** (by sheet ID) rather than the live API — a different, older mechanism than `importFromTebraApi`. |

### 1.15 Billing channel & claim record persistence (FE-called)

| Function | Lines | What it does |
|---|---|---|
| `savePatientClaimRecord` | 5099–5186 | Saves claim-submission static fields (Member ID, PCN, etc.) for a patient. |
| `savePatientBestChannel` | 5196–5240 | Saves the computed "best billing channel" suggestion for a patient. |
| `setPatientBillingChannel` | 5267–5311 | Sets a patient's default billing/payment channel. |

### 1.16 Rate analysis (FE-called generators + readers)

| Function | Lines | What it does |
|---|---|---|
| `generateRateAnalysis` | 6358–6517 | Aggregates paid Clinic-Submit claims by carrier/state/CPT and writes the Rate Analysis tab. |
| `getRateAnalysisData` | 6524–6549 | **FE-called.** Reads that tab back as JSON for `RateAnalysisPanel`. |
| `generateProviderRateAnalysis` | 6560–6709 | Same aggregation, with Provider added as an outer grouping dimension; writes a separate tab. Self-documented as "same logic as `generateRateAnalysis()`" — see §3. |
| `getProviderRateAnalysisData` | 6716–6740 | **FE-called.** Reads the by-provider tab back as JSON. |

### 1.17 Payment import (FE-called)

| Function | Lines | What it does |
|---|---|---|
| `bulkImportPayments` | 6748–6894 | Applies a batch of imported payment rows (from `PaymentImportPanel`'s CSV/XLSX drag-and-drop) to the Appointments sheet. |

---

## 2. Hardcoded values

**Real secrets are handled correctly and are not hardcoded.** Tebra API credentials (`TEBRA_CUSTOMER_KEY`, `TEBRA_PASSWORD`, `TEBRA_USER`) are read exclusively via `PropertiesService.getScriptProperties()` in `_getTebraCreds` (line 2752) — the standard, correct Apps Script pattern for secrets. No API key, password, or token literal was found anywhere in the file.

What *is* hardcoded:

- **`LOGO_FILE_ID`** (line 24) — a Google Drive file ID, already a properly-named top-level constant. Its only consumer, `getLogoBase64`, has no callers (§4) — so this constant is itself currently unused.
- **`TEBRA_ENDPOINT`** (line 2698) — the Tebra/Kareo SOAP base URL, already a properly-named constant, correctly reused by the two production call sites (`_tebraPost` line 2794, `_fetchServiceLocationMap` line 3373). However, two of the manual test functions hardcode the *same* URL as a fresh local literal instead of referencing the constant: `testTebraWsdl` (line 3093) and `testTebraFindInsuranceField` (line 3125) both do `var BASE = 'https://webservice.kareo.com/services/soap/2.1/KareoServices.svc?xsd=';`. Low-stakes since both are throwaway diagnostics, but a real duplicate of an existing constant.
- **`http://www.kareo.com/api/schemas/...`** — the SOAP XML namespace URIs (not fetchable endpoints, just namespace identifiers required by the WSDL contract) appear as repeated literals across `_tebraHeader`, `_fetchServiceLocationMap`, and a few `test*` functions (lines 2785, 2790, 3344–3351, 3377) rather than a shared constant. Lower priority than `TEBRA_ENDPOINT` since these are boilerplate namespace strings, not environment-specific config, but still six-plus repetitions of the same string.
- **`TEBRA_IMPORT_SHEET_ID`** (line 2418) — defined as an **empty string** (`const TEBRA_IMPORT_SHEET_ID = '';`), i.e. a placeholder that was apparently never filled in. Its only consumer is the legacy `importTebraAppointments`/`runTebraImport` pathway (§1.14 / §4).
- **`STAFF_SEED`** (lines 115–124) — a 9-row array of real staff email addresses (`@solreibehavioralhealth.com`) paired with role/provider-ID/display-name. This is *already* structured configuration (not loose literals scattered through the code), so there's no extraction to recommend — flagging only because the instructions asked to note where email addresses appear. Not printing the addresses themselves here since they're real staff PII; see `Code.js:115-124` directly.
- No IP addresses were found anywhere in `Code.js` (the hardcoded LAN IP found earlier in `crb_index.html`'s `BestChannelHint` is frontend-only and has already been extracted into a constant there).

## 3. Duplicated / near-identical logic

- **`testPatientAuth_Try1_ClientVersion` / `_Try2_GetPatients` / `_Try3_WithPracticeID`** (lines 6082–6185) — three sequential auth-troubleshooting scripts, each rebuilding the same `RequestHeader` XML boilerplate (`ClientVersion`/`CustomerKey`/`Password`/`User`) and the same try/catch/log wrapper, varying only the SOAP operation name, requested fields, and filter. Try2 and Try3 are nearly identical to each other (only Try3 adds a `PracticeID` filter element). All three are clearly a manual "try it three different ways" debugging sequence, not production code — flagging per the request, not suggesting cleanup given they're one-off diagnostics.
- **`generateRateAnalysis`** (6358–6517) **vs `generateProviderRateAnalysis`** (6560–6709) — structurally near-identical: same aggregation-by-carrier/state/CPT logic over the same paid-claims data, with the provider version adding an extra `provId`/`provDisplay` dimension threaded through the grouping key, sort, and output columns, and writing to a separate tab. This one is **self-documented** — the header comment directly above `generateProviderRateAnalysis` reads: *"Same logic as `generateRateAnalysis()` but adds Provider as the outermost grouping dimension. Writes to a separate sheet tab so the simple (non-provider) analysis is never overwritten."* So the duplication is intentional and acknowledged by whoever wrote it, not an accident.
- **Not duplication — a legitimate, repeated pattern worth noting so it isn't mistaken for the above:** several pairs of one-line wrapper functions exist purely so Apps Script's editor function-dropdown offers a "safe" and "force" (or "dry-run" and "live") entry point, both delegating to one shared implementation: `runBackfillInsuranceCarrier`/`runBackfillInsuranceCarrierForce` → `backfillInsuranceCarrier`; `runSyncPatientStates`/`runSyncPatientStatesForce` → `syncPatientStates`; `bulkVerifyQ1_2026_dryRun`/`bulkVerifyQ1_2026` → `_bulkVerifyRange`. These are correctly factored (one real implementation, thin named entry points) — not flagged as a problem.

## 4. Dead code

Of the 128 functions, **46** have no call found from elsewhere in `Code.js` and are not called from `crb_index.html` via `gsr()`. That's a large fraction, but the overwhelming majority of them are exactly what you'd expect in an Apps Script ops codebase: functions named `test*`, `debug*`, `run*`, `migrate*`, `backfill*`, `repair*`, `clean*`/`cleanup*`, or `bulkVerify*` are, by this file's own convention (several have literal "Apps Script editor → function dropdown → runXyz" instructions in their header comments), meant to be invoked manually by a human picking them from the editor's function list — not called from other code. Those are listed in their respective groups above (§1.4, §1.11, §1.12, §1.13) and are **not** re-litigated here as "dead" — that's their intended usage pattern.

What's left after excluding that whole category, and `doGet` (the reserved Web App entry point, invoked by the Apps Script runtime itself, never by name in source) — four functions that look like genuine leftover dead code, not intentional standalone utilities:

- **`getLogoBase64`** (line 272) — reads `LOGO_FILE_ID` from Drive and returns it as base64. Checked both directions: no caller in `Code.js`, and no reference to it anywhere in `crb_index.html` either. The frontend now embeds its logo directly as a hardcoded base64 data-URI constant, `EMBEDDED_LOGO` (`crb_index.html:10738`), with a comment at line 10735 explicitly telling whoever edits that file to "paste the ORIGINAL EMBEDDED_LOGO string ... into this exact slot." That strongly suggests `getLogoBase64`/`LOGO_FILE_ID` is the *previous* mechanism for getting the logo into the page (fetch from Drive at load time), since replaced by embedding the image directly — leaving both the function and, functionally, `LOGO_FILE_ID` orphaned.
- **`_apptSheet`** (line 2118) — a one-line helper (`return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_APPT);`) with zero callers anywhere. Every other function that needs the Appointments sheet just inlines this same lookup directly (there are 25+ separate `ss.getSheetByName(TAB_APPT)` call sites across the file) rather than calling this helper — it appears to have been added but never adopted.
- **`_parseTebraApiDate`** (2821–2826) **and `_parseTebraApiTime`** (2828–2851) — both have zero references anywhere outside their own definitions. `_parseTebraStartDate` (2853–2880), immediately below them, handles combined start-date+time parsing and *is* actively used — these two look like earlier, narrower parsing helpers that were superseded by it and never removed.
- **The legacy import pathway** (§1.14): `runTebraImport` → `runTebraImportDryRun` → `importTebraAppointments`. Neither wrapper has any caller, and `importTebraAppointments` itself is called only by those two wrappers — so the whole three-function chain is unreachable from the frontend and from any other part of the codebase. It imports from an already-exported Tebra spreadsheet (`TEBRA_IMPORT_SHEET_ID`), which is defined as an **empty string placeholder** that was never filled in (§2) — consistent with this being an earlier import mechanism (spreadsheet export → import) that was fully superseded by the direct-API pipeline (`importFromTebraApi`, §1.9), which *is* frontend-called and is the one wired to the "Sync Tebra" buttons.

One additional note, not "dead" but worth flagging since it came up while tracing callers: **`auditUnsignedNotes`** (v1, line 1075) has a **v2** immediately below it (line 1280) with an almost identical read-only-audit structure and its own explicit "Apps Script editor → function dropdown → auditUnsignedNotesV2" run instructions. V2's own comment references "the gap `auditUnsignedNotesV2` found 2026-07-25," implying V1 was audited, found lacking, and V2 was written to close the gap. V1 has zero callers, same as V2 — both are equally "manually run" by the file's own convention, so neither is technically more or less dead than the other, but V1 may be functionally superseded and kept only for reference. Not proposing removal — read-only mapping, per the task.

---

*No changes were made to `Code.js` in the course of producing this document.*
