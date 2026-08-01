# Patient Name Display Locations — Reference Map

Read-only investigation of every place `crb_index.html` renders a patient's name to a user, as of the current commit. Line numbers are a snapshot and will drift on the next edit. No changes were made to `crb_index.html` to produce this document.

## Summary — the pattern that matters most

Almost every appointment-row/card/header location renders the name from an **appointment object** (`a`, `d`, or `appt`) that ultimately came from `rowToAppt()` in `Code.js`. That backend function already computes and denormalizes `patientState` directly onto every appointment record (`APPT_COLS` index 54, populated from the Patient DB on every save — see `saveAppointment`'s stamping logic). So for the large majority of locations below, **`<var>.patientState` is already sitting on the same object whose `.patient` field is being rendered** — no additional lookup needed.

There are exactly **three exceptions** — backend endpoints with their own hand-picked, trimmed output shapes that don't include `patientState` at all:

| Endpoint | Used by | Fields returned |
|---|---|---|
| `searchPatient` (`Code.js:538`) | `GlobalSearch` | `provID, date, time, patient, method, status, out, billing` — no `patientState` |
| `getNoteBoard` (`Code.js:1931`) | `NoteBoardPanel` | `id, date, time, patient, provID, noteStatus, signed` — no `patientState` |
| `getClaimsLedger` (`Code.js:2016`) | `ClaimsLedger` | `provID, id, patient, memberID, carrier, date, cpt, ...` — no `patientState` |

All three call `rowToAppt(r)` internally (so the value was *computed*), then build a custom object that leaves it out. At these three locations, showing a state abbreviation would require either adding `patientState` to that endpoint's returned shape, or a separate `patientDb` lookup by name on the frontend.

**No location anywhere in the file currently displays a state abbreviation next to a patient's name.** That column below is included per your request but is `No` everywhere without exception.

---

## Full location list

| # | Line(s) | Component / View | What's shown | `patientState` in scope? | Abbrev shown today? |
|---|---|---|---|---|---|
| 1 | `11379` | `UnsignedAlert` — unsigned-notes banner pill (Day view, all windows) | `{a.patient}` | ✅ `a.patientState` (on the appt object) | No |
| 2 | `11438` | `UnsignedWeekAlert` — same banner, week view | `{a.patient}` | ✅ `a.patientState` | No |
| 3 | `11555` | `PatientSearch` — autocomplete dropdown (used only by `AddModal`) | `{p.firstName} {p.lastName}` | ✅ `p.patientState` (`p` is a `patientDb`/`getPatients` record) | No |
| 4 | `11676` | `CPTModal` — modal header | `{appt.patient}` | ✅ `appt.patientState` | No |
| 5 | `11855` | `RxMedModal` — modal header | `{appt.patient}` | ✅ `appt.patientState` | No |
| 6 | `12187` | `PatientModal` — modal title header | `{d.patient}` | ✅ `d.patientState` | No |
| 7 | `12206` | `PatientModal` — editable "Patient Name" field | `value={d.patient}` | ✅ `d.patientState` | No |
| 8 | `12494` | `DayDirectPayBanner` (Provider Day view) — "Needs Collection" row | `{a.patient}` | ✅ `a.patientState` (passed through `dpSummary()` unchanged) | No |
| 9 | `12517` | `DayDirectPayBanner` — "Collected" row | `{a.patient}` | ✅ `a.patientState` | No |
| 10 | `12697` | `ProviderApptModal` — modal header | `{appt.patient}` | ✅ `appt.patientState` | No |
| 11 | `12985` | `NoteBoardPanel` — note board row | `{row.patient}` | ❌ **Not available** — `getNoteBoard`'s trimmed shape omits it (see Summary) | No |
| 12 | `13309-13310` | `ClaimsLedger` — claims table row (`splitPatientName(r.patient)`) | `{first}` / `{last}` | ❌ **Not available** — `getClaimsLedger`'s trimmed shape omits it | No |
| 13 | `13467` | `PatientInfoModal` — modal header | `{appt.patient}` | ✅ `appt.patientState` | No |
| 14 | `13845` | `ProviderView` — Pre-visit row, clickable name link | `{a.patient}` | ✅ `a.patientState` | No |
| 15 | `13968` | `ProviderView` — Post-visit row, clickable name link | `{a.patient}` | ✅ `a.patientState` | No |
| 16 | `14393` | `WeekView` (Provider) — active appointment card | `{a.patient}` | ✅ `a.patientState` | No |
| 17 | `14433` | `WeekView` — void/cancelled audit card (struck through) | `{a.patient}` | ✅ `a.patientState` | No |
| 18 | `14497` | `CommentsPopup` — modal header | `{appt.patient}` | ✅ `appt.patientState` | No |
| 19 | `14697` | `AllProviderWeekView` (Assistant/Billing week) — active appointment card | `{a.patient}` | ✅ `a.patientState` | No |
| 20 | `14751` | `AllProviderWeekView` — void/cancelled audit card | `{a.patient}` | ✅ `a.patientState` | No |
| 21 | `14985` | `AssistantView` — main Day-view table row | `{a.patient}` | ✅ `a.patientState` | No |
| 22 | `15084` | `AssistantView` — Void Appointment Archive table row | `{a.patient}` | ✅ `a.patientState` | No |
| 23 | `15303` | `BillingChannelsPanel` — patient list row | `{fullName}` (built from `p.firstName`/`p.lastName`) | ✅ `p.patientState` (`patientDb` record) | No |
| 24 | `15860` | `ClaimSubmitModal` — modal header | `{appt.patient}` | ✅ `appt.patientState`, and a separate `ptRec.patientState` lookup already exists too (`15657-15659`) | No |
| 25 | `16487` | `DirectPaySection` (Billing Day view) — **email alert body**, not a screen render (`sendAlert()`, builds a `mailto:` link) | `${a.patient}` in email text | ✅ `a.patientState` | No |
| 26 | `16504` | `DirectPaySection` — standalone "$0 Copay, no collection needed" row | `{a.patient}` | ✅ `a.patientState` | No |
| 27 | `16550` | `DirectPaySection` — main collection row (expanded view) | `{a.patient}` | ✅ `a.patientState` | No |
| 28 | `16660` | `DirectPaySection` — "$0 Copay" strip row (mixed collection view) | `{a.patient}` | ✅ `a.patientState` | No |
| 29 | `16740` | `BillerApptModal` — modal header | `{d.patient}` | ✅ `d.patientState`, and `ptRec.patientState` also already looked up (`16685-16687`) | No |
| 30 | `17464` | `BillingView` → `BRow` — "Best Billing Channel" popup header | `{a.patient}` | ✅ `a.patientState` | No |
| 31 | `17588` | `BillingView` → `BRow` — main billing card name | `{a.patient}` | ✅ `a.patientState` | No |
| 32 | `17984` | `GlobalSearch` — search-results dropdown, grouped-by-patient header | `{group.name}` (= `r.patient`) | ❌ **Not available** — `searchPatient`'s trimmed shape omits it | No |

## Notable absence

**`PSearchResult`** (`crb_index.html:17868-17892`) — the individual result row rendered under each `GlobalSearch` group header — does **not** display the patient's name at all. It shows date, time, provider, method, status, and signed-state, but the name only appears once, at the group-header level (`#32` above), not per-row. Worth knowing if a state abbreviation were ever wanted at the row level specifically — it isn't there to attach to today.

## A few locations excluded as false positives

The initial text search also matched a number of spots that turned out to be internal lookups/comparisons, not name *displays* — e.g. `getPatientBilling`/`getPatientInfo`/`ptInfo`/`savedChannel`'s `patientDb.find(p => \`${p.firstName} ${p.lastName}\`.toLowerCase() === ...)` matching logic in `ProviderView`, `BillingView`, `ClaimSubmitModal`, and `BillerApptModal`; `AddModal`'s `handleSelect(p)` setting local state; and `BillingChannelsPanel`'s internal search-filter/sort/key-building helpers. These are excluded from the table above since nothing is rendered to the user at those specific lines — only the actual display point (where present) is listed.
