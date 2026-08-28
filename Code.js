/**
 * ═══════════════════════════════════════════════════════════════
 *  Solrei Behavioral Health — Clinic Readiness Board
 *  Google Apps Script  |  Container-Bound to Google Sheet
 * ═══════════════════════════════════════════════════════════════
 *
 *  TABS:
 *    Appointments  — daily appointment & billing data
 *    Patients      — master patient list (edit directly in Sheet)
 *    Audit Log     — system-written HIPAA audit trail (locked)
 *    Staff         — email → role mapping (pre-populated by initializeSheets)
 *
 *  SETUP (run once):
 *    1. Paste this file into Extensions > Apps Script in your Sheet
 *    2. Paste index.html as a new HTML file named "crb_index" in the same project
 *    3. Run  initializeSheets()  to create tabs, headers, and seed Staff roster
 *    4. Deploy > New Deployment > Web App
 *         Execute as: Me
 *         Who has access: Anyone in [your org domain]
 *    5. Share the Web App URL with your team
 */

// ── Solrei logo (Google Drive file ID) ──────────────────────────
const LOGO_FILE_ID = '1chGqD9IBx5UcTM9lqnptWpQKYgUlg17S';

// ── Tab names ────────────────────────────────────────────────────
const TAB_APPT = 'Appointments';
const TAB_PATIENT = 'Patients';
const TAB_AUDIT = 'Audit Log';
const TAB_STAFF = 'Staff';
const TAB_RATE_ANALYSIS = 'Rate Analysis';
const TAB_RATE_ANALYSIS_PROV = 'Rate Analysis - By Provider';
const TAB_PAYMENT_MANUAL = 'PaymentTrackerManual';

// ── Appointment sheet columns (order matters — do not rearrange) ─
// ── Terminology note (Solrei OS naming cleanup) ──────────────────────────
// Method → BillingChannel · PaymentType → CostShareClass ·
// PaymentRate → CostShareRate · PaymentAmount → CostShareCollectedAmt ·
// PaymentPlatform → PaymentProcessingChannel. Renamed here AND on the live
// Patients/Appointments tab header rows via renameHeadersForTerminologyCleanup()
// — run that migration once before deploying this file. Column POSITIONS are
// unchanged; only the label text changed, so numeric-index-based row access
// elsewhere in this file needed no changes.
// SCOPE OF THIS PASS: spreadsheet header text, the PATIENT_COLS/APPT_COLS
// constants and every indexOf() lookup against them, and user-facing UI
// labels in crb_index.html. Internal-only JS identifiers deep in the file
// (PLATFORM_TO_METHOD, METHODS, PLATFORM_MAP, METHOD_LABEL, METHOD_COLOR,
// and object property names like .method/.platform/.paymentType passed
// between frontend and backend) were intentionally left as-is — renaming
// those touches far more surface area for no user-visible benefit. Flag to
// Dean if he wants that deeper pass done too.
// NOTE: Dean's spec named this column "CostShareCollected", but that string
// nearly collides with the existing boolean column immediately after it,
// "PaymentCollected" (was collection successful, yes/no — not renamed, not
// part of Dean's list). Used "CostShareCollectedAmt" here instead so the
// dollar-amount column and the yes/no flag column stay clearly distinct —
// exactly the kind of ambiguity this cleanup is meant to remove. Flagged to
// Dean; easy to change back to the literal spec if he prefers.
const APPT_COLS = [
  'ProvID', 'Date', 'ApptID', 'Time', 'Patient', 'BillingChannel',
  'AlmaText', 'AlmaValid', 'HWText', 'HWValid', 'GrowText', 'GrowValid',
  'DirectIns', 'Intake', 'InsVerified', 'Autopay',
  'PHQ9', 'GAD7', 'PCL5', 'CCEHR', 'Notes',
  'UnsignedDates', 'CPTCodes', 'Billing', 'Status', 'Signed',
  'CostShareClass', 'CostShareRate', 'CostShareCollectedAmt',
  'PaymentCollected', 'PaymentFailed',
  'Comms', 'LastModified', 'ModifiedBy',
  'TebraStatus', 'PaymentDate', 'RxMeds', 'RxBillerAlert', 'PaymentProcessingChannel',
  // ── Claim tracking & payout (indices 39-47) ──────────────────────────────
  'ClaimSubmittedDate', 'ClaimID', 'ClaimStatus', 'ClaimStatusInfo',
  'ClaimPaidDate', 'ClaimPaidAmount', 'ClaimCheckID',
  'ClaimDepositBank', 'ClaimDepositDate',
  // ── Direct-pay validity flag (index 48) ──────────────────────────────────
  // Mirrors AlmaValid/HWValid/GrowValid — stores the explicit valid/issue/null
  // choice the assistant makes for direct-pay appointments.
  'DirectValid',
  // ── Claims Ledger supplemental fields (indices 49-52) ────────────────────
  'ClaimERA',           // ERA number associated with the payment batch
  'ClaimBundled',       // TRUE if this claim was paid in a bundled check
  'ClaimBundledAmount', // Total amount of the bundled check
  'ClaimDepositAmount', // Amount actually deposited to the bank (index 52)
  // ── Patient context — denormalized from Patient DB for query support ──────
  // Populated automatically on every save so single-sheet queries can join
  // method + CPT codes + insurance + state without a cross-sheet lookup.
  'InsuranceCarrier',  // Patient's insurance carrier (index 53)
  'PatientState',      // Patient's state of residence (index 54)
  // ── Clinic Note Status (index 55) ────────────────────────────────────────
  // '' = not started, 'in_progress' = assistant working on it,
  // 'ready' = formatted and ready for provider review
  'NoteStatus',        // Assistant-updated note formatting status (index 55)
  // ── Screener score data + clinical/issue notes (indices 56-58) ───────────
  // Entered by the assistant in the PatientModal; displayed read-only to the
  // provider in PatientInfoModal and ProviderApptModal.
  'ScrData',           // JSON — { 'PHQ-9': { score: '' }, 'GAD-7': ..., 'PCL-5': ... }
  'ScrNote',           // Free-text clinical notes the assistant writes for the provider
  'ChecklistNote',     // Free-text issue reasons for Intake/Insurance/Autopay/CC flags
];

// Terminology note (Solrei OS naming cleanup): Platform → BillingChannel ·
// Insurance → InsuranceCarrier · PatientPortion → CostShareClass ·
// ClaimPlatform → ClaimGateway · PaymentPlatform → PaymentProcessingChannel.
// See the matching note above APPT_COLS.
const PATIENT_COLS = [
  // ── Core (indices 0-5) ───────────────────────────────────────
  'FirstName', 'LastName', 'BillingChannel', 'InsuranceCarrier', 'CostShareClass', 'Rate',
  // ── Claim submission static fields (indices 6-16) ────────────
  'ClaimGateway', 'MemberID', 'MemberDOB', 'PCN',
  'GroupNumber', 'PrimarySubscriber', 'PatientState',
  'RenderingNPI', 'BillingNPI', 'xCode',
  'PaymentProcessingChannel',  // index 16 — default collection channel (Tebra, Chase, etc.)
  'BestChannel',      // index 17 — JSON: {channel, payer, state, rate, cpts, updatedAt}
  'PatientID',        // index 18 — NEW (2026-08-17) — real Tebra internal Patient ID.
  // PHI. Restores capture that patient_id_system's integration
  // depends on but which had gone missing from this file.
];

// Billing-channel label (Patients tab, e.g. "Headway") → Appointments-tab
// short code (e.g. "hw"). Several functions already carry their own
// function-scoped copy of this exact literal (the Tebra Excel-import
// parser, _buildPatientLookup()) — those are left alone since touching
// them is out of scope here. This top-level copy exists so new code
// (setPatientBillingChannel's appointment-propagation step) has one
// shared definition to reuse instead of writing a third copy.
const PLATFORM_TO_METHOD = { 'alma': 'alma', 'headway': 'hw', 'grow': 'grow', 'direct': 'direct' };

// Reverse of PLATFORM_TO_METHOD — Appointments-tab short code → Patients-tab
// billing-channel label. Used to convert a row's/appt's short-code method
// back into the label setPatientBillingChannel() expects before calling it.
const METHOD_TO_PLATFORM = { 'alma': 'Alma', 'hw': 'Headway', 'grow': 'Grow', 'direct': 'Direct' };

const STAFF_COLS = ['Email', 'Role', 'ProvID', 'DisplayName'];

const STAFF_SEED = [
  ['jodene@solreibehavioralhealth.com', 'provider', 'jodene', 'Jodene'],
  ['katie@solreibehavioralhealth.com', 'provider', 'katie', 'Katie'],
  ['lori@solreibehavioralhealth.com', 'provider', 'lori', 'Lori'],
  ['jeloah@solreibehavioralhealth.com', 'assistant', '*', 'Jeloah'],
  ['jemaica@solreibehavioralhealth.com', 'assistant', '*', 'Jemaica'],
  ['marianne@solreibehavioralhealth.com', 'assistant', '*', 'Marianne'],
  ['cassandra@solreibehavioralhealth.com', 'assistant', '*', 'Cassandra'],
  ['dean@solreibehavioralhealth.com', 'biller', '*', 'Dean'],
];

// ── PLACEHOLDER_PATIENT_NAMES (2026-07-27) ──────────────────────────────
// Calendar-block entries providers use to hold personal time on their Tebra
// schedule (mail time, admin blocks, etc.) — these are NOT real patients and
// must never reach the Appointments tab or the Patients tab.
//
// This used to be 4 separate hardcoded copies of this same list, scattered
// across getTotalUnsignedCount / the audit function / getNoteBoard — all
// READ-side only, meaning they hid placeholders from unsigned-note counts
// but never stopped them from being WRITTEN in the first place. That's
// exactly how "Jodene Mail" / "Kr Appt1" / "Lk Block" ended up as real rows
// in both sheets: Tebra's actual block-entry names had drifted from the
// hardcoded list (e.g. "JODENE BUSY MAC MAIL" → "Jodene Mail"), so the sync
// silently stopped recognizing them as placeholders and imported them as if
// they were real patients. Now a single shared list, checked at the
// SOURCE — inside _fetchTebraAppointments' _invalid filter — so a
// placeholder never enters allAppts and therefore never gets written to
// either sheet or upserted into Patients. If a provider renames their
// block entry in Tebra again, add the new exact name here (uppercased).
const PLACEHOLDER_PATIENT_NAMES = [
  'JODENE BUSY MAC MAIL', 'JODENE MAIL',
  'KR H2 KATIES APPT1', 'KR APPT1', 'KR BLOCK',
  'JJ BLOCK', 'LK BLOCK',
  'DEAN TEST',
];


// ── _sv(v): safe string conversion that preserves numeric 0 ──────
// Standard `String(v || '')` drops numeric 0 (falsy) → '' instead of '0'.
// Use _sv() wherever cell values might legitimately be 0 (e.g. paymentRate, rate).
function _sv(v) {
  return (v !== undefined && v !== null && v !== '') ? String(v) : '';
}

// True only for a genuine $0/0% rate — blank/unset is NOT zero (nothing
// entered yet is a different state from "confirmed nothing owed"). Mirrors
// the frontend's isZeroRate() in crb_index.html; kept in sync manually
// since Code.js and crb_index.html don't share modules.
function _isZeroRate(rate) {
  if (rate === null || rate === undefined || rate === '') return false;
  var n = parseFloat(String(rate).replace(/[$%,\s]/g, ''));
  return !isNaN(n) && n === 0;
}


/* ════════════════════════════════════════════════════════════════
   SERVE THE WEB APP
════════════════════════════════════════════════════════════════ */
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('crb_index')
    .setTitle('SolBoard - CRB — Solrei Behavioral Health')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}


/* ════════════════════════════════════════════════════════════════
   ONE-TIME SETUP
════════════════════════════════════════════════════════════════ */
function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let apptSheet = ss.getSheetByName(TAB_APPT);
  if (!apptSheet) apptSheet = ss.insertSheet(TAB_APPT);
  if (apptSheet.getLastRow() === 0) {
    apptSheet.appendRow(APPT_COLS);
    styleHeaderRow(apptSheet, APPT_COLS.length, '#09371F', '#F2EDDB');
    apptSheet.setFrozenRows(1);
    apptSheet.setColumnWidth(1, 80);
    apptSheet.setColumnWidth(2, 100);
    apptSheet.setColumnWidth(5, 180);
  }
  apptSheet.setTabColor('#09371F');

  let patSheet = ss.getSheetByName(TAB_PATIENT);
  if (!patSheet) patSheet = ss.insertSheet(TAB_PATIENT);
  if (patSheet.getLastRow() === 0) {
    patSheet.appendRow(PATIENT_COLS);
    styleHeaderRow(patSheet, PATIENT_COLS.length, '#3D768A', '#FBFBF3');
    patSheet.setFrozenRows(1);
    [130, 130, 90, 200, 110, 90].forEach((w, i) => patSheet.setColumnWidth(i + 1, w));
    patSheet.getRange('C2:C2000').setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['Alma', 'Headway', 'Grow', 'Direct'], true)
        .setAllowInvalid(false).build()
    );
    patSheet.getRange('E2:E2000').setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['copay', 'coinsurance', 'cash-pay'], true)
        .setAllowInvalid(false).build()
    );
    patSheet.getRange('F1').setNote(
      'Enter a dollar amount (e.g. 30) for copay/cash-pay.\nEnter a percentage (e.g. 20%) for coinsurance.'
    );
  }
  patSheet.setTabColor('#3D768A');

  let auditSheet = ss.getSheetByName(TAB_AUDIT);
  if (!auditSheet) auditSheet = ss.insertSheet(TAB_AUDIT);
  if (auditSheet.getLastRow() === 0) {
    auditSheet.appendRow(['Timestamp', 'User', 'Action', 'Details']);
    styleHeaderRow(auditSheet, 4, '#2B2716', '#F2EDDB');
    auditSheet.setFrozenRows(1);
    [160, 220, 120, 400].forEach((w, i) => auditSheet.setColumnWidth(i + 1, w));
    try {
      const prot = auditSheet.protect().setDescription('Audit Log — system writes only');
      const me = Session.getActiveUser().getEmail();
      const editors = prot.getEditors().filter(e => e.getEmail() !== me);
      if (editors.length) prot.removeEditors(editors);
      if (prot.canDomainEdit()) prot.setDomainEdit(false);
    } catch (e) {
      Logger.log('Could not lock Audit Log: ' + e.message);
    }
  }
  auditSheet.setTabColor('#777355');

  let staffSheet = ss.getSheetByName(TAB_STAFF);
  if (!staffSheet) staffSheet = ss.insertSheet(TAB_STAFF);
  if (staffSheet.getLastRow() === 0) {
    staffSheet.appendRow(STAFF_COLS);
    styleHeaderRow(staffSheet, STAFF_COLS.length, '#777355', '#F2EDDB');
    staffSheet.setFrozenRows(1);
    [280, 100, 80, 140].forEach((w, i) => staffSheet.setColumnWidth(i + 1, w));
    staffSheet.getRange('B2:B200').setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInList(['provider', 'assistant', 'biller'], true)
        .setAllowInvalid(false).build()
    );
    STAFF_SEED.forEach(row => staffSheet.appendRow(row));
    try {
      const prot = staffSheet.protect().setDescription('Staff roles — admin only');
      const me = Session.getActiveUser().getEmail();
      const editors = prot.getEditors().filter(e => e.getEmail() !== me);
      if (editors.length) prot.removeEditors(editors);
      if (prot.canDomainEdit()) prot.setDomainEdit(false);
    } catch (e) {
      Logger.log('Could not lock Staff sheet: ' + e.message);
    }
  }
  staffSheet.setTabColor('#777355');

  SpreadsheetApp.flush();
  Logger.log('✅ Solrei Clinic Readiness Board — sheets initialized.');
  return 'Done! Tabs created: Appointments, Patients, Audit Log, Staff.';
}

function styleHeaderRow(sheet, numCols, bg, fg) {
  const r = sheet.getRange(1, 1, 1, numCols);
  r.setBackground(bg).setFontColor(fg).setFontWeight('bold').setFontSize(11);
}


/* ════════════════════════════════════════════════════════════════
   READ — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function getAppointments(prov, date) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const deny = _checkProvAccess(ss, prov);
    if (deny) return deny;
    const sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    const rows = sheet.getDataRange().getValues().slice(1);

    // ── Day's appointments (raw, before unsigned override) ──────────
    const dayAppts = rows
      .filter(r => String(r[0]) === prov && _fmtDate(r[1]) === date)
      .map(function (r) {
        var a = rowToAppt(r);
        // Standalone attribution columns (66-69) — read directly by number,
        // not via rowToAppt, since they're deliberately kept out of
        // APPT_COLS (see the comment above NOTE_PROGRESS_BY_COL).
        a.noteInProgressBy = String(r[NOTE_PROGRESS_BY_COL - 1] || '');
        a.noteInProgressAt = String(r[NOTE_PROGRESS_AT_COL - 1] || '');
        a.noteReadyBy = String(r[NOTE_READY_BY_COL - 1] || '');
        a.noteReadyAt = String(r[NOTE_READY_AT_COL - 1] || '');
        a.noteSignedBy = String(r[NOTE_SIGNED_BY_COL - 1] || '');
        a.noteSignedAt = String(r[NOTE_SIGNED_AT_COL - 1] || '');
        return a;
      });

    if (dayAppts.length === 0) return JSON.stringify([]);

    // ── Dynamically compute unsigned[] for each patient ─────────────
    // Signed + TebraStatus + the row's own date/time are the source of
    // truth (revised 2026-08-04, see _isUnsignedEligible). We scan EVERY
    // row for each patient present today and rebuild unsigned[] fresh from
    // rows that actually need a signed note right now.
    //
    // Rules:
    //   • A row needs a note once its own date+time has passed and it's
    //     not void, and Signed != TRUE (_isUnsignedEligible)
    //   • Only dates strictly before 'date' (today's slot is excluded —
    //     it is recorded as unsigned in the sheet but NOT shown in the
    //     banner; filterDisplayUnsigned on the front-end handles this
    //     but we keep the back-end consistent too)
    //   • Result is de-duplicated and stored in MM/DD/YY format

    // Collect normalised patient names present today
    const patientSet = {};
    dayAppts.forEach(function (a) {
      patientSet[_normName(a.patient)] = true;
    });

    // Build: normName → Set<MM/DD/YY> of unsigned dates
    const patientUnsigned = {};  // key: normName, value: Set of date strings

    rows.forEach(function (r) {
      var rProv = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      if (rProv !== prov) return;                          // different provider
      if (!patientSet[rPatNorm]) return;                   // not in today's list

      var rDate = _fmtDate(r[1]);  // YYYY-MM-DD
      if (!rDate || rDate >= date) return;                 // future or same day — skip

      if (!_isUnsignedEligible(String(r[34] || ''), r[1], r[3], r[25])) return;

      var dateStr = _toUnsignedDateStr(rDate);             // → MM/DD/YY
      if (!dateStr) return;

      if (!patientUnsigned[rPatNorm]) {
        patientUnsigned[rPatNorm] = {};
      }
      patientUnsigned[rPatNorm][dateStr] = true;
    });

    // Override unsigned[] on each appointment using the freshly computed set.
    // No merge with column V — the stored UnsignedDates text is inert now,
    // this dynamic scan is the only source of truth.
    dayAppts.forEach(function (a) {
      var norm = _normName(a.patient);
      a.unsigned = patientUnsigned[norm] ? Object.keys(patientUnsigned[norm]) : [];
    });

    return JSON.stringify(dayAppts);
  } catch (e) {
    Logger.log('getAppointments error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

function getWeekAppointments(prov, weekStartDate) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const deny = _checkProvAccess(ss, prov);
    if (deny) return deny;
    const sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({});

    const [y, m, d] = weekStartDate.split('-').map(Number);
    const dates = Array.from({ length: 7 }, (_, i) => {
      const dt = new Date(y, m - 1, d + i);
      return [
        dt.getFullYear(),
        String(dt.getMonth() + 1).padStart(2, '0'),
        String(dt.getDate()).padStart(2, '0')
      ].join('-');
    });
    const dateSet = new Set(dates);
    const allRows = sheet.getDataRange().getValues().slice(1);

    const result = {};
    dates.forEach(ds => { result[`${prov}||${ds}`] = []; });

    // Collect week appointments first
    allRows
      .filter(r => String(r[0]) === prov && dateSet.has(_fmtDate(r[1])))
      .forEach(r => {
        const key = `${String(r[0])}||${_fmtDate(r[1])}`;
        if (result[key]) result[key].push(rowToAppt(r));
      });

    // ── Dynamically rebuild unsigned[] from actual Signed=FALSE rows ──
    // Same logic as getAppointments — ensures week banner shows correct
    // unsigned counts even for Tebra-synced rows with empty col V.
    const weekStart = dates[0];
    const weekEnd = dates[dates.length - 1];

    // Collect all patients in this week's appointments (for this provider)
    const patientSet = {};
    dates.forEach(function (ds) {
      (result[prov + '||' + ds] || []).forEach(function (a) {
        patientSet[_normName(a.patient)] = true;
      });
    });

    // Build normName → Set<MM/DD/YY> of unsigned dates strictly before weekEnd.
    // A row needs a note once its own date+time has passed and it's not void
    // (revised 2026-08-04, see _isUnsignedEligible).
    const patientUnsigned = {};
    allRows.forEach(function (r) {
      var rProv = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      if (rProv !== prov) return;
      if (!patientSet[rPatNorm]) return;

      var rDate = _fmtDate(r[1]);
      if (!rDate) return;
      // Include unsigned dates up through the last day of the week
      // (each day's slot filters its own date via filterDisplayUnsigned on FE)
      if (rDate > weekEnd) return;

      if (!_isUnsignedEligible(String(r[34] || ''), r[1], r[3], r[25])) return;

      var dateStr = _toUnsignedDateStr(rDate);
      if (!dateStr) return;

      if (!patientUnsigned[rPatNorm]) patientUnsigned[rPatNorm] = {};
      patientUnsigned[rPatNorm][dateStr] = true;
    });

    // Override unsigned[] on all week appointments — freshly computed only,
    // no merge with column V (inert now; Signed + TebraStatus are the source
    // of truth).
    dates.forEach(function (ds) {
      (result[prov + '||' + ds] || []).forEach(function (a) {
        var norm = _normName(a.patient);
        a.unsigned = patientUnsigned[norm] ? Object.keys(patientUnsigned[norm]) : [];
      });
    });

    return JSON.stringify(result);
  } catch (e) {
    Logger.log('getWeekAppointments error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


function getAllWeekAppointments(weekStartDate) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({});

    var parts = weekStartDate.split('-').map(Number);
    var y = parts[0], m = parts[1], d = parts[2];
    var dates = [];
    for (var i = 0; i < 7; i++) {
      var dt = new Date(y, m - 1, d + i);
      dates.push([
        dt.getFullYear(),
        String(dt.getMonth() + 1).padStart(2, '0'),
        String(dt.getDate()).padStart(2, '0'),
      ].join('-'));
    }
    var dateSet = {};
    dates.forEach(function (ds) { dateSet[ds] = true; });

    var result = {};
    dates.forEach(function (ds) { result[ds] = []; });

    var allRows = sheet.getDataRange().getValues().slice(1);
    var weekEnd = dates[dates.length - 1];

    allRows
      .filter(function (r) { return !!dateSet[_fmtDate(r[1])]; })
      .forEach(function (r) {
        var ds = _fmtDate(r[1]);
        if (result[ds]) {
          var appt = rowToAppt(r);
          appt.provID = String(r[0] || '');
          result[ds].push(appt);
        }
      });

    // ── Dynamically rebuild unsigned[] from actual Signed=FALSE rows ──
    // Collect all patients present in this week across all providers
    var patientSet = {};
    dates.forEach(function (ds) {
      (result[ds] || []).forEach(function (a) {
        var key = (a.provID || '') + '||' + _normName(a.patient);
        patientSet[key] = true;
      });
    });

    // Build provID+normName → Set<MM/DD/YY> of unsigned dates. A row needs a
    // note once its own date+time has passed and it's not void (revised
    // 2026-08-04, see _isUnsignedEligible).
    var patientUnsigned = {};
    allRows.forEach(function (r) {
      var rProv = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      var key = rProv + '||' + rPatNorm;
      if (!patientSet[key]) return;

      var rDate = _fmtDate(r[1]);
      if (!rDate || rDate > weekEnd) return;

      if (!_isUnsignedEligible(String(r[34] || ''), r[1], r[3], r[25])) return;

      var dateStr = _toUnsignedDateStr(rDate);
      if (!dateStr) return;

      if (!patientUnsigned[key]) patientUnsigned[key] = {};
      patientUnsigned[key][dateStr] = true;
    });

    // Override unsigned[] on all week appointments — freshly computed only,
    // no merge with column V (inert now; Signed + TebraStatus are the source
    // of truth).
    dates.forEach(function (ds) {
      (result[ds] || []).forEach(function (a) {
        var key = (a.provID || '') + '||' + _normName(a.patient);
        a.unsigned = patientUnsigned[key] ? Object.keys(patientUnsigned[key]) : [];
      });
    });

    return JSON.stringify(result);
  } catch (e) {
    Logger.log('getAllWeekAppointments error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   SEARCH — PATIENT APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function searchPatient(query) {
  try {
    var q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return JSON.stringify([]);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);

    var today = _fmtDate(new Date());
    var values = sheet.getDataRange().getValues().slice(1);
    var matches = [];
    var ID_IDX = APPT_COLS.indexOf('ApptID');

    values.forEach(function (r) {
      var patient = String(r[4] || '').trim();
      if (patient.toLowerCase().indexOf(q) === -1) return;
      var date = _fmtDate(r[1]);
      if (!date) return;
      matches.push({
        apptId: String(r[ID_IDX] || ''),
        provID: String(r[0] || ''),
        date: date,
        time: _fmtTime(r[3]),
        patient: patient,
        method: String(r[5] || ''),
        status: String(r[24] || 'pending'),
        out: r[25] === true || r[25] === 'TRUE',
        billing: String(r[23] || 'pending'),
      });
    });

    matches.sort(function (a, b) {
      var aUp = a.date >= today, bUp = b.date >= today;
      if (aUp && !bUp) return -1;
      if (!aUp && bUp) return 1;
      if (aUp) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
    });

    return JSON.stringify(matches.slice(0, 60));
  } catch (e) {
    Logger.log('searchPatient error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Returns the CPT codes from a patient's most recent PAST appointment with
 * a given provider that already has CPT codes assigned.
 *
 * Matches patientName by exact normalized equality (same style as
 * diagnoseNewPatient's Appointments-tab comparison) — this identifies one
 * specific patient precisely, unlike searchPatient's loose substring match
 * for its live-search box.
 *
 * Returns [] if no matching row is found. No fallback/default codes are
 * applied here — this function's only job is to report what's actually on
 * file, honestly, including "nothing." Any default-code fallback belongs
 * in a later stage, not here.
 */
function getLastCodedAppointment(patientName, provID) {
  try {
    var target = String(patientName || '').trim().toLowerCase();
    if (!target || !provID) return [];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return [];

    var COL_PATIENT = APPT_COLS.indexOf('Patient');
    var COL_PROV_ID = APPT_COLS.indexOf('ProvID');
    var COL_DATE = APPT_COLS.indexOf('Date');
    var COL_CPT = APPT_COLS.indexOf('CPTCodes');

    var today = _fmtDate(new Date());
    var rows = sheet.getDataRange().getValues();
    var matches = [];

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      var ptCell = String(r[COL_PATIENT] || '').trim().toLowerCase();
      if (ptCell !== target) continue;

      if (String(r[COL_PROV_ID] || '').trim() !== String(provID).trim()) continue;

      var date = _fmtDate(r[COL_DATE]);
      if (!date || date >= today) continue;

      if (!r[COL_CPT]) continue;

      matches.push({ date: date, cptRaw: r[COL_CPT] });
    }

    if (!matches.length) return [];

    matches.sort(function (a, b) {
      return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
    });

    return String(matches[0].cptRaw).split(/[|,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
  } catch (e) {
    Logger.log('getLastCodedAppointment error: ' + e.message);
    return [];
  }
}



/* ════════════════════════════════════════════════════════════════
   WRITE — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function saveAppointment(prov, date, apptJson) {
  try {
    const appt = JSON.parse(apptJson);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const deny = _checkProvAccess(ss, prov);
    if (deny) return deny;
    const sheet = ss.getSheetByName(TAB_APPT);

    const values = sheet.getDataRange().getValues();
    let targetRow = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][2]) === String(appt.id)) {
        targetRow = i + 1;
        break;
      }
    }

    const TIME_COL = APPT_COLS.indexOf('Time') + 1;
    const UNSIGNED_COL = APPT_COLS.indexOf('UnsignedDates') + 1;

    // ── Ensure the sheet has enough columns for the full row data ──────────
    // apptToRow() returns APPT_COLS.length columns. If the sheet was created
    // before some columns were added, setValues() would throw out-of-bounds.
    const requiredCols = APPT_COLS.length;
    if (sheet.getMaxColumns() < requiredCols) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredCols - sheet.getMaxColumns());
      // Write headers for any newly added columns
      const hdrRange = sheet.getRange(1, 1, 1, requiredCols);
      const existingHdrs = hdrRange.getValues()[0];
      const newHdrs = existingHdrs.slice();
      APPT_COLS.forEach(function (col, i) {
        if (!newHdrs[i]) newHdrs[i] = col;
      });
      hdrRange.setValues([newHdrs]);
    }

    if (targetRow > 0) {
      // ── UPDATE path ──
      // Column V (UnsignedDates) is physically maintained now (2026-08-04) —
      // full patient-wide recomputation is expensive, so routine saves just
      // preserve whatever's already on the sheet rather than recomputing it.
      // Full-cascade reconciliation only happens on Mark Note Signed
      // (_reconcilePatientUnsignedDates) and the nightly sweep.
      var apptData = Object.assign({}, appt);   // mutable copy — don't mutate parsed JSON

      // ── Manual-override detection (2026-08-26) — captured BEFORE the
      // Patient-DB stamp below runs, so this compares what the CLIENT
      // actually sent against what was already on the sheet, not the
      // post-stamp value. Every onUpdate call in the frontend spreads the
      // full current appointment object plus explicit overrides, so for
      // any save that doesn't intentionally touch InsuranceCarrier,
      // appt.insuranceCarrier already equals the sheet's current value —
      // this only reads as "manually edited" when a human genuinely typed
      // a new value via ProvChannelModal/BillerApptModal, never as a side
      // effect of the automatic Patient-DB stamp re-deriving the field for
      // an unrelated save. Same array `values` already read above; may be
      // shorter than INSURANCE_CARRIER_MANUAL_AT_COL for any row that
      // predates this column, in which case indexing past the array's end
      // returns undefined — `|| ''` treats that as not-yet-manually-set,
      // the correct default.
      var IC_IDX_FOR_ATTRIB = APPT_COLS.indexOf('InsuranceCarrier');
      var oldInsuranceCarrier = String(values[targetRow - 1][IC_IDX_FOR_ATTRIB] || '');
      var clientSentInsuranceCarrier = String(appt.insuranceCarrier || '');
      var insuranceCarrierManuallyEdited = clientSentInsuranceCarrier !== oldInsuranceCarrier;
      var wasInsuranceCarrierManuallySet = String(values[targetRow - 1][INSURANCE_CARRIER_MANUAL_AT_COL - 1] || '').trim();

      // ── Stamp InsuranceCarrier + PatientState from Patient DB ────────────
      // Always refresh from the source of truth so records stay accurate even
      // when the patient DB is updated after the appointment was created —
      // UNLESS a human has manually set this row's InsuranceCarrier
      // (wasInsuranceCarrierManuallySet), in which case the Patient-DB stamp
      // is skipped entirely and whatever the client sent is kept as-is; a
      // manual edit must never get silently overwritten by this same stamp
      // on the very next unrelated save.
      // Priority when not manually set: Patient DB > existing appointment value > directIns (direct only).
      var patInfo = _lookupPatient(ss, apptData.patient);
      if (!wasInsuranceCarrierManuallySet) {
        apptData.insuranceCarrier = patInfo.insurance
          || apptData.insuranceCarrier
          || (apptData.method === 'direct' ? apptData.directIns : '')
          || '';
      }
      apptData.patientState = patInfo.patientState || apptData.patientState || '';

      const rowData = apptToRow(apptData, prov, date);

      // ── Billing-channel change detection (2026-08-19) ────────────────────
      // If this edit changes the row's own channel, clear the OUTGOING
      // channel's verification fields on THIS row inline (rowData hasn't
      // been written yet) — same clearing rules
      // _propagateBillingChannelToFutureAppointments() uses for every OTHER
      // future row, just applied directly here since this row's own write
      // is already in flight. DirectIns is the patient's insurance carrier
      // name, not a verification note — never cleared.
      var CHAN_IDX = APPT_COLS.indexOf('BillingChannel');
      var oldMethod = String(values[targetRow - 1][CHAN_IDX] || '').trim().toLowerCase();
      var newMethod = String(apptData.method || '').trim().toLowerCase();
      var channelChanged = newMethod !== oldMethod;

      if (channelChanged) {
        if (oldMethod === 'alma') {
          rowData[APPT_COLS.indexOf('AlmaText')] = '';
          rowData[APPT_COLS.indexOf('AlmaValid')] = '';
        } else if (oldMethod === 'hw') {
          rowData[APPT_COLS.indexOf('HWText')] = '';
          rowData[APPT_COLS.indexOf('HWValid')] = '';
        } else if (oldMethod === 'grow') {
          rowData[APPT_COLS.indexOf('GrowText')] = '';
          rowData[APPT_COLS.indexOf('GrowValid')] = '';
        } else if (oldMethod === 'direct') {
          rowData[APPT_COLS.indexOf('DirectValid')] = '';
          // DirectIns is the patient's insurance carrier name, not a
          // verification note — never clear it here.
        }
      }

      // ── Preserve Tebra-synced columns that the client may not have ──
      // If the incoming appt has no tebraStatus (e.g. the provider loaded
      // their page before the biller ran a Tebra sync), keep whatever value
      // is already in the sheet so we don't silently overwrite it.
      const TS_IDX = APPT_COLS.indexOf('TebraStatus'); // 0-based
      if (TS_IDX >= 0 && !apptData.tebraStatus) {
        const sheetRow = values[targetRow - 1];  // values[] was read above
        const sheetTebra = sheetRow && sheetRow.length > TS_IDX
          ? String(sheetRow[TS_IDX] || '') : '';
        if (sheetTebra) rowData[TS_IDX] = sheetTebra;
      }

      // ── Preserve UnsignedDates as-is ──
      // Not recomputed on routine saves (see comment above) — carry forward
      // whatever's already on the sheet for this row.
      const UNSIGNED_IDX = APPT_COLS.indexOf('UnsignedDates'); // 0-based
      const sheetRowForV = values[targetRow - 1];
      rowData[UNSIGNED_IDX] = sheetRowForV && sheetRowForV.length > UNSIGNED_IDX
        ? String(sheetRowForV[UNSIGNED_IDX] || '') : '';

      sheet.getRange(targetRow, TIME_COL).setNumberFormat('@');
      sheet.getRange(targetRow, UNSIGNED_COL).setNumberFormat('@');
      // Force plain-text format on date fields to prevent Sheets auto-converting
      // ISO strings ('2026-03-16') back to Date objects on next read.
      [36, 40, 44, 48].forEach(function (c) { sheet.getRange(targetRow, c).setNumberFormat('@'); });
      sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
      _audit(ss, 'UPDATE', `${apptData.patient} | ${apptData.time} | ${date} | ${prov}`);

      // ── Intake Updates ───────────────────────────────────────────────────
      // Standalone column (99 / CU, outside apptToRow()'s fixed-width return
      // — see the comment above INTAKE_UPDATES_COL), so it needs its own
      // targeted write here, same as INSURANCE_CARRIER_MANUAL_BY/AT_COL just
      // below. No attribution stamp needed — each entry already carries its
      // own author/date/time (built client-side in PatientModal, same
      // buildComment()-style shape Comms/Messages already uses), so this is
      // purely "write the array if it changed," never a WHO/WHEN pair.
      var newIntakeUpdates = JSON.stringify(apptData.intakeUpdates || []);
      var oldIntakeUpdates = String(values[targetRow - 1][INTAKE_UPDATES_COL - 1] || '[]');
      if (newIntakeUpdates !== oldIntakeUpdates) {
        sheet.getRange(targetRow, INTAKE_UPDATES_COL).setValue(newIntakeUpdates);
      }

      // ── InsuranceCarrier Manual-Override Attribution ────────────────────
      // Same "only fires when it actually changed" discipline as Note
      // Status Attribution below — insuranceCarrierManuallyEdited was
      // computed above from the RAW client payload vs. the sheet's prior
      // value, before the Patient-DB stamp ran, so this only fires for a
      // genuine edit through ProvChannelModal/BillerApptModal, never as a
      // side effect of an unrelated save. Stamped in the same operation as
      // the row write above, not a separate step — if this save fails,
      // neither the value nor the timestamp lands; if it succeeds, both do.
      if (insuranceCarrierManuallyEdited) {
        _stampAttribution(ss, sheet, targetRow, INSURANCE_CARRIER_MANUAL_BY_COL, INSURANCE_CARRIER_MANUAL_AT_COL);
        _audit(ss, 'INSURANCE_CARRIER_MANUAL_SET',
          `Appt ${appt.id} → InsuranceCarrier="${clientSentInsuranceCarrier}" (manual, was "${oldInsuranceCarrier}")`);
      }

      // ── Note Status Attribution ────────────────────────────────────────
      // The inline "NOTE STATUS" column in the Assistant day view saves
      // through this full-appointment path, not saveNoteStatus — so
      // attribution has to be stamped here too. Only fires when noteStatus
      // actually changed from what was already on the sheet; an unrelated
      // field edit that happens to re-save the same noteStatus value must
      // NOT reset who gets credit. Standalone columns 66-69 — see the
      // comment above NOTE_PROGRESS_BY_COL for why they're kept out of
      // APPT_COLS.
      var NS_IDX_FOR_ATTRIB = APPT_COLS.indexOf('NoteStatus');
      var oldNoteStatus = String(values[targetRow - 1][NS_IDX_FOR_ATTRIB] || '');
      var newNoteStatus = String(apptData.noteStatus || '');
      if (newNoteStatus !== oldNoteStatus) {
        var attribEmail = Session.getActiveUser().getEmail();
        var attribStaff = _getStaffRecord(ss, attribEmail);
        var attribWho = (attribStaff && attribStaff.displayName) ? attribStaff.displayName : attribEmail;
        var attribNow = new Date().toISOString();
        if (newNoteStatus === 'in_progress') {
          sheet.getRange(targetRow, NOTE_PROGRESS_BY_COL).setValue(attribWho);
          sheet.getRange(targetRow, NOTE_PROGRESS_AT_COL).setValue(attribNow);
        } else if (newNoteStatus === 'ready') {
          sheet.getRange(targetRow, NOTE_READY_BY_COL).setValue(attribWho);
          sheet.getRange(targetRow, NOTE_READY_AT_COL).setValue(attribNow);
        } else {
          sheet.getRange(targetRow, NOTE_PROGRESS_BY_COL).setValue('');
          sheet.getRange(targetRow, NOTE_PROGRESS_AT_COL).setValue('');
          sheet.getRange(targetRow, NOTE_READY_BY_COL).setValue('');
          sheet.getRange(targetRow, NOTE_READY_AT_COL).setValue('');
        }
        _audit(ss, 'NOTE_STATUS_UPDATED',
          'Appt ' + appt.id + ' → noteStatus=' + (newNoteStatus || '(cleared)') + ' by ' + attribEmail + ' (via saveAppointment)');
      }

      // Runs AFTER this row's own write, so setPatientBillingChannel()'s
      // internal re-scan of the Appointments tab sees this row already
      // updated to its new channel (correctly skips re-touching it — its
      // channel already matches the new default).
      if (channelChanged) {
        try {
          var newLabel = METHOD_TO_PLATFORM[newMethod] || '';
          setPatientBillingChannel(apptData.patient, newLabel);
        } catch (e) {
          Logger.log('saveAppointment: billing-channel propagation failed (non-fatal): ' + e.message);
        }
      }
    } else {
      // ── CREATE path ──
      // Seed UnsignedDates with every other currently-outstanding unsigned
      // date this same patient already has (e.g. scheduling a follow-up
      // while an earlier visit's note is still unsigned) — a single-patient
      // scoped scan, cheap enough to run on every create (2026-08-04).
      appt.unsigned = _computeUnsignedDatesForNewAppt(values, _normName(appt.patient), prov, _fmtDate(date));

      // ── Stamp InsuranceCarrier + PatientState from Patient DB ────────────
      var patInfoNew = _lookupPatient(ss, appt.patient);
      appt.insuranceCarrier = patInfoNew.insurance
        || (appt.method === 'direct' ? appt.directIns : '')
        || '';
      appt.patientState = patInfoNew.patientState || '';

      // ── Billing-channel override detection (2026-08-19) ─────────────────
      // If the channel picked for this new appointment differs from the
      // patient's current Patients-tab default, treat it the same as a
      // manual channel edit on an existing appointment: it becomes the new
      // default and propagates to the patient's other future appointments.
      // (AddModal pre-fills from the current default, so this only fires
      // when someone deliberately picks something else before saving.)
      var currentDefaultLabel = _getPatientBillingChannelLabel(ss, appt.patient);
      var currentDefaultShort = PLATFORM_TO_METHOD[currentDefaultLabel.toLowerCase()] || '';
      var newMethodOnCreate = String(appt.method || '').trim().toLowerCase();
      var channelOverriddenOnCreate = !!newMethodOnCreate && newMethodOnCreate !== currentDefaultShort;

      // Write the new row.
      const rowData = apptToRow(appt, prov, date);
      const newRow = sheet.getLastRow() + 1;
      sheet.getRange(newRow, TIME_COL).setNumberFormat('@');
      sheet.getRange(newRow, UNSIGNED_COL).setNumberFormat('@');
      // Force plain-text format on date fields to prevent Sheets auto-converting
      // ISO strings ('2026-03-16') back to Date objects on next read.
      [36, 40, 44, 48].forEach(function (c) { sheet.getRange(newRow, c).setNumberFormat('@'); });
      sheet.getRange(newRow, 1, 1, rowData.length).setValues([rowData]);

      _audit(ss, 'CREATE', `${appt.patient} | ${appt.time} | ${date} | ${prov}`);

      // Runs AFTER this row's own write so setPatientBillingChannel()'s
      // internal re-scan sees this new row already in place (correctly
      // skips re-touching it — its channel already matches). Best-effort,
      // same as the UPDATE-path call above.
      if (channelOverriddenOnCreate) {
        try {
          var newLabelOnCreate = METHOD_TO_PLATFORM[newMethodOnCreate] || '';
          setPatientBillingChannel(appt.patient, newLabelOnCreate);
        } catch (e) {
          Logger.log('saveAppointment (CREATE): billing-channel propagation failed (non-fatal): ' + e.message);
        }
      }
    }

    SpreadsheetApp.flush();
    return JSON.stringify({ ok: true });
  } catch (e) {
    Logger.log('saveAppointment error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/** Normalize to MM/DD/YY without timezone drift. */
function _toUnsignedDateStr(d) {
  if (!d) return '';
  const s = String(d).trim();

  // MM/DD/YY or MM/DD/YYYY (or single-digit variants)
  const slash = s.split('/');
  if (slash.length === 3 && slash.every(x => /^\d+$/.test(x.trim()))) {
    const yr = slash[2].trim().length === 4 ? slash[2].trim().slice(2) : slash[2].trim();
    return `${slash[0].trim().padStart(2, '0')}/${slash[1].trim().padStart(2, '0')}/${yr.padStart(2, '0')}`;
  }

  // ISO YYYY-MM-DD — parse manually, NO Date() (avoids UTC → local shift).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[2]}/${iso[3]}/${iso[1].slice(2)}`;
  }

  // Last-resort fallback. Safe here because ISO is handled above.
  const dt = new Date(s);
  if (!isNaN(dt.getTime())) {
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    const yy = String(dt.getFullYear()).slice(2);
    return `${mm}/${dd}/${yy}`;
  }
  return s;
}


/* ════════════════════════════════════════════════════════════════
   NOTE SIGNED — marks one appointment Signed=TRUE.
   ─────────────────────────────────────────────────────────────
   Simplified 2026-07-24: Signed + TebraStatus are now the only source
   of truth for "does this need a signed note" (see _visitOccurred and
   the note above APPT_COLS). There is no more accumulated UnsignedDates
   list to scan and strip across the patient's other rows — nothing is
   stored anywhere else that could go stale or get double-counted.
   Once this row's Signed flag is TRUE, the dynamic rebuilds in
   getAppointments/getWeekAppointments/getAllWeekAppointments simply
   stop finding it, everywhere, permanently.

   Response shape kept the same for frontend compatibility — `cleared`
   and `affected` are always empty now; the frontend's own optimistic
   update already clears the signed date from its local caches, and the
   next fresh read recomputes unsigned[] dynamically.
     { ok: true, signed: <0 or 1>, cleared: 0, affected: [] }
════════════════════════════════════════════════════════════════ */

/** Normalize a name for comparison: lowercase, trim, collapse internal whitespace. */
function _normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function signNoteAndClearUnsigned(apptId, signedISO, patient) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Auth check
    var email = Session.getActiveUser().getEmail();
    var staff = _getStaffRecord(ss, email);
    if (!staff || staff.role === 'unknown') {
      return JSON.stringify({ ok: false, error: 'Access denied: unrecognized user.' });
    }

    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: true, signed: 0, cleared: 0, affected: [] });
    }

    var COL_ID = APPT_COLS.indexOf('ApptID') + 1;  // C = 3
    var COL_SIGNED = APPT_COLS.indexOf('Signed') + 1;  // Z = 26
    var PROV_IDX = APPT_COLS.indexOf('ProvID');       // 0-based, A = 0
    var SIGNED_IDX = COL_SIGNED - 1;                    // 0-based

    var data = sheet.getDataRange().getValues();
    var idN = String(apptId || '').trim();

    var signed = 0;
    var reconciled = 0;
    for (var i = 1; i < data.length; i++) {
      var rowId = String(data[i][COL_ID - 1] || '').trim();
      if (rowId !== idN) continue;
      sheet.getRange(i + 1, COL_SIGNED).setValue(true);
      data[i][SIGNED_IDX] = true;  // keep in-memory copy in sync for the reconcile pass below
      signed++;
      Logger.log('signNoteAndClearUnsigned: row ' + (i + 1) + ' marked Signed=TRUE ' +
        '(ApptID=' + idN + ', patient="' + patient + '", date=' + signedISO + ')');

      // Note-signed attribution (Stage 1, 2026-08-09) — who/when the SIGN
      // action itself happened, distinct from signedISO above (which is the
      // appointment's own date, not a timestamp) and from the Signed
      // boolean. Reuses the staff lookup already done for the auth check.
      var signedWho = (staff && staff.initials) ? staff.initials : (staff && staff.displayName) ? staff.displayName : email;
      sheet.getRange(i + 1, NOTE_SIGNED_BY_COL).setValue(signedWho);
      sheet.getRange(i + 1, NOTE_SIGNED_AT_COL).setValue(new Date().toISOString());

      // Physically clean this date out of every other UnsignedDates cell for
      // this patient+provider now that it's signed (2026-08-04).
      var provID = String(data[i][PROV_IDX] || '');
      reconciled = _reconcilePatientUnsignedDates(sheet, data, _normName(patient), provID);
      break; // ApptID is unique — no need to keep scanning once found
    }

    SpreadsheetApp.flush();

    _audit(ss, 'SIGN', 'Patient: ' + patient + ' | Date: ' + signedISO + ' | Signed: ' + signed);

    return JSON.stringify({ ok: true, signed: signed, cleared: reconciled, affected: [] });
  } catch (e) {
    Logger.log('signNoteAndClearUnsigned ERROR: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ ok: false, error: e.message });
  }
}

/**
 * Clears a "phantom" unsigned date from a patient's UnsignedDates cells.
 *
 * Safe to call even when two patients share the same full name: the function
 * checks whether the patient actually has an appointment row on `dateStr`.
 * If they do, it refuses to clear (that would be a real unsigned note that
 * must be signed through the normal Note Signed flow).  Only rows where the
 * patient has NO appointment on `dateStr` have that date removed.
 *
 * This handles the case where a same-name back-fill contaminated a patient's
 * UnsignedDates column with a date that belongs to a different patient.
 */
function clearPhantomUnsignedDate(apptId, dateStr) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: true, cleared: 0 });

    var email = Session.getActiveUser().getEmail();
    var staff = _getStaffRecord(ss, email);
    if (!staff || staff.role === 'unknown') {
      return JSON.stringify({ ok: false, error: 'Access denied.' });
    }

    var ID_IDX = APPT_COLS.indexOf('ApptID');         // 0-based
    var DATE_IDX = APPT_COLS.indexOf('Date');           // 0-based
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');        // 0-based
    var UNSIGNED_IDX = APPT_COLS.indexOf('UnsignedDates');  // 0-based
    var COL_UNSIGNED = UNSIGNED_IDX + 1;                    // 1-based for getRange

    var idN = String(apptId || '').trim();
    var targetISO = _normalizeDateStr(dateStr);
    if (!idN || !targetISO) {
      return JSON.stringify({ ok: false, error: 'apptId and dateStr are required.' });
    }

    var values = sheet.getDataRange().getValues();
    var patientN = null;

    // ── Step 1: Resolve the patient's normalized name from the appointment row ──
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][ID_IDX] || '').trim() === idN) {
        patientN = _normName(String(values[i][PATIENT_IDX] || ''));
        break;
      }
    }
    if (!patientN) {
      return JSON.stringify({ ok: false, error: 'Appointment not found: ' + apptId });
    }

    // ── Step 2: Collect dates this patient actually has appointment rows for ──
    var apptDateSet = {};
    for (var j = 1; j < values.length; j++) {
      if (_normName(String(values[j][PATIENT_IDX] || '')) !== patientN) continue;
      var rd = _fmtDate(values[j][DATE_IDX]);
      if (rd) apptDateSet[rd] = true;
    }

    // ── Step 3: Safety guard — if the patient HAS an appointment on this date,
    // it is a legitimate unsigned note; don't touch it.
    if (apptDateSet[targetISO]) {
      return JSON.stringify({
        ok: false,
        error: 'Patient has an appointment on ' + targetISO +
          '. Use Note Signed to clear this — it is a real unsigned note.',
      });
    }

    // ── Step 4: Remove targetISO from ALL rows for this patient ──────────────
    var cleared = 0;
    for (var k = 1; k < values.length; k++) {
      if (_normName(String(values[k][PATIENT_IDX] || '')) !== patientN) continue;
      var rawCell = String(values[k][UNSIGNED_IDX] || '').trim();
      if (!rawCell) continue;
      var dates = rawCell.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var filtered = dates.filter(function (d) { return _normalizeDateStr(d) !== targetISO; });
      if (filtered.length < dates.length) {
        var cell = sheet.getRange(k + 1, COL_UNSIGNED);
        cell.setNumberFormat('@');
        cell.setValue(filtered.join(','));
        cleared++;
      }
    }

    _audit(ss, 'PHANTOM_CLEAR',
      'Patient: ' + patientN + ' | Ghost Date: ' + targetISO +
      ' | ApptID: ' + apptId + ' | Rows updated: ' + cleared);

    SpreadsheetApp.flush();
    return JSON.stringify({ ok: true, cleared: cleared, patient: patientN, date: targetISO });
  } catch (e) {
    Logger.log('clearPhantomUnsignedDate ERROR: ' + e.message);
    return JSON.stringify({ ok: false, error: e.message });
  }
}

/**
 * Returns the total count of outstanding (past) unsigned notes for a provider.
 *
 * Source of truth: the Signed column (col Z) plus TebraStatus. We count every
 * appointment row where (a) the provider matches, (b) the appointment date is
 * strictly before today, (c) TebraStatus shows the visit actually occurred —
 * "Confirmed" or "Checked Out" only, per the clinic standard set 2026-07-24
 * (see _visitOccurred) — and (d) Signed ≠ TRUE. Column V (UnsignedDates) is
 * no longer read anywhere; Signed + TebraStatus are the only signals.
 */
/**
 * Returns true for Tebra appointment statuses that represent a void / cancelled
 * slot — these rows should never contribute to the unsigned note count.
 */
function _isVoidStatus(tebraStatus) {
  if (!tebraStatus) return false;
  var s = String(tebraStatus).toLowerCase().trim();
  return s === 'no show' || s === 'noshow' || s === 'no-show' ||
    s === 'rescheduled' || s === 'needsreschedule' || s === 'needs reschedule' ||
    s === 'cancelled' || s === 'canceled' ||
    s === 'deleted in tebra'; // row's Tebra ID vanished from the sync feed —
  // see importFromTebraApi's _findStaleRows fix (2026-07-26)
}

/* ════════════════════════════════════════════════════════════════════
   CLINIC STANDARD (established 2026-07-24, effective immediately) —
   Solrei's six TebraStatus values and what they mean for note tracking:
     Scheduled  — appointment booked. Automatic, always accurate. NOT a
                  completed visit — never needs a signed note.
     Confirmed  — the appointment happened and is complete. This is the
                  ONLY status that represents a real, pending "needs a
                  signed note" item.
     Checked Out (Tebra sends "Check-out") — the provider has signed the
                  note. Equivalent to SolBoard's own "Mark Note Signed."
                  A row at this status should never appear as unsigned.
     No Show / Rescheduled / Cancelled — void, handled by _isVoidStatus.

   _normalizeStatusWord / _isConfirmedStatus / _isCheckedOutStatus /
   _visitOccurred are the shared eligibility rule used everywhere a
   "does this row need a signed note" decision is made — the unsigned
   count badge, the day/week dynamic rebuilds, and Tebra Sync's new
   auto-reconciliation (see the "TebraStatus: ALWAYS overwrite" block).
   Normalizes by stripping everything but letters and lowercasing, so
   "Check-out", "Checked Out", "CHECK OUT", and "checkout" all match.
════════════════════════════════════════════════════════════════════ */
function _normalizeStatusWord(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}
function _isConfirmedStatus(tebraStatus) {
  return _normalizeStatusWord(tebraStatus) === 'confirmed';
}
function _isCheckedOutStatus(tebraStatus) {
  var n = _normalizeStatusWord(tebraStatus);
  return n === 'checkout' || n === 'checkedout' || n === 'checkoutcomplete';
}
/** True only for statuses that represent an actual completed visit per
 *  Tebra's own status field. Still used for auto-sign-on-Checkout
 *  reconciliation (Tebra sync) and getOverdueDirectPay — NOT used for
 *  unsigned-note eligibility anymore, see _isUnsignedEligible below. */
function _visitOccurred(tebraStatus) {
  return _isConfirmedStatus(tebraStatus) || _isCheckedOutStatus(tebraStatus);
}

/* ════════════════════════════════════════════════════════════════════
   UNSIGNED-NOTE ELIGIBILITY (revised 2026-08-04, replaces the
   _visitOccurred-based rule above for this purpose specifically) —
   Dean's report: gating on Tebra's own ConfirmationStatus reaching
   "Confirmed" silently under-counted, because nothing in SolBoard ever
   advances that field except Tebra's own sync feed. A real, completed,
   still-unsigned visit whose status was never manually confirmed inside
   Tebra — or is older than the 90-day full-sync window — sat at
   "Scheduled" forever and never counted, no matter how overdue.

   New rule: an appointment needs a signed note once its OWN scheduled
   date+time has passed, full stop — independent of whatever Tebra's
   status field says. Void appointments (No Show/Rescheduled/Cancelled)
   still never need one. This is the one shared rule every read/count
   function below uses, plus the audit/correction function — so they
   can never drift apart from each other the way the badge and the V1
   audit tab once did.
════════════════════════════════════════════════════════════════════ */

// 'YYYY-MM-DDTHH:MM' for an appointment's own date+time — string-comparable,
// no Date() construction (avoids UTC/local-timezone drift, same reasoning
// _fmtDate/_toUnsignedDateStr already use elsewhere in this file).
function _apptDateTimeKey(dateVal, timeVal) {
  var d = _fmtDate(dateVal);
  if (!d) return '';
  var t = _fmtTime(timeVal);
  return d + 'T' + (t || '00:00');
}

function _nowDateTimeKey() {
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  return Utilities.formatDate(now, tz, 'yyyy-MM-dd') + 'T' + Utilities.formatDate(now, tz, 'HH:mm');
}

/** True once THIS SPECIFIC appointment's own scheduled date+time is in the
 *  past (or right now) — independent of TebraStatus. */
function _apptTimeHasPassed(dateVal, timeVal) {
  var key = _apptDateTimeKey(dateVal, timeVal);
  if (!key) return false;
  return key <= _nowDateTimeKey();
}

/** The one shared "does this row need a signed note right now" rule. */
function _isUnsignedEligible(tebraStatus, dateVal, timeVal, signedVal) {
  if (_isVoidStatus(tebraStatus)) return false;
  if (!_apptTimeHasPassed(dateVal, timeVal)) return false;
  var isSigned = signedVal === true || String(signedVal).trim().toUpperCase() === 'TRUE';
  return !isSigned;
}

/** What the Signed cell SHOULD contain for a row that isn't itself TRUE:
 *  blank if the appointment hasn't happened yet, FALSE once it has, and
 *  blank (never FALSE) for a void appointment since it will never need a
 *  note. Callers must check for an existing TRUE themselves first — this
 *  is never used to downgrade a real TRUE. */
function _expectedSignedValue(tebraStatus, dateVal, timeVal) {
  if (_isVoidStatus(tebraStatus)) return '';
  return _apptTimeHasPassed(dateVal, timeVal) ? false : '';
}

/** The correct UnsignedDates value for a brand-new row being added for
 *  patient+provider on ownDate: every OTHER currently-outstanding
 *  unsigned-eligible date for that same patient+provider strictly before
 *  ownDate, as an array of MM/DD/YY strings (caller joins with ','). */
function _computeUnsignedDatesForNewAppt(rows, patientNorm, provID, ownDate) {
  var outstanding = {};
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[0] || '') !== provID) continue;
    if (_normName(String(r[4] || '')) !== patientNorm) continue;
    var rDate = _fmtDate(r[1]);
    if (!rDate || rDate >= ownDate) continue;
    if (!_isUnsignedEligible(String(r[34] || ''), r[1], r[3], r[25])) continue;
    outstanding[rDate] = true;
  }
  return Object.keys(outstanding).sort().map(_toUnsignedDateStr);
}

/** Recomputes and writes the correct UnsignedDates value on EVERY row
 *  belonging to one patient+provider, based on the current Signed/
 *  TebraStatus/date state of every other row for that same patient+
 *  provider. Only writes cells that actually differ from their current
 *  value. Returns the number of cells changed. `allRows` must be a fresh
 *  getDataRange().getValues() read (header included, 0-indexed). */
function _reconcilePatientUnsignedDates(sheet, allRows, patientNorm, provID) {
  var UNSIGNED_COL = APPT_COLS.indexOf('UnsignedDates') + 1;
  var matches = [];
  for (var i = 1; i < allRows.length; i++) {
    var r = allRows[i];
    if (String(r[0] || '') !== provID) continue;
    if (_normName(String(r[4] || '')) !== patientNorm) continue;
    matches.push({
      sheetRow: i + 1,
      date: _fmtDate(r[1]),
      time: r[3],
      tebraStatus: String(r[34] || ''),
      signed: r[25],
      currentV: String(r[UNSIGNED_COL - 1] || ''),
    });
  }
  if (matches.length === 0) return 0;

  var outstandingDates = matches
    .filter(function (m) { return m.date && _isUnsignedEligible(m.tebraStatus, m.date, m.time, m.signed); })
    .map(function (m) { return m.date; });

  var changed = 0;
  matches.forEach(function (m) {
    if (!m.date) return;
    var priorDates = outstandingDates.filter(function (d) { return d < m.date; }).sort();
    var expectedV = priorDates.map(_toUnsignedDateStr).join(',');
    if (expectedV !== m.currentV) {
      sheet.getRange(m.sheetRow, UNSIGNED_COL).setValue(expectedV);
      changed++;
    }
  });
  return changed;
}

/** Nightly comprehensive safety net (2026-08-04), called from
 *  overnightSyncTebraApi() right after the Tebra import completes.
 *
 *  Pass 1: flips any genuinely-blank Signed cells to FALSE once their own
 *  appointment date+time has passed and the status isn't void. Never
 *  touches a cell that's already TRUE or FALSE.
 *
 *  Pass 2: re-reads the sheet and runs a full UnsignedDates reconciliation
 *  for every provider+patient group, so column V stays accurate even for
 *  rows created outside the normal saveAppointment/signNote flow (e.g. the
 *  Tebra import path, which doesn't compute V itself — see apptToRow).
 *
 *  Returns a summary object; also logs via Logger.log and _audit. */
function nightlyReconcileUnsignedNotes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  var summary = { flipped: 0, patientsReconciled: 0, cellsChanged: 0 };
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('nightlyReconcileUnsignedNotes: no appointment rows — nothing to do.');
    return summary;
  }

  var PROV_IDX = APPT_COLS.indexOf('ProvID');
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var TIME_IDX = APPT_COLS.indexOf('Time');
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');
  var SIGNED_IDX = APPT_COLS.indexOf('Signed');
  var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
  var SIGNED_COL = SIGNED_IDX + 1;

  var rows = sheet.getDataRange().getValues();

  // ── Pass 1: blank → FALSE once the appointment's own time has passed ──
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var signedVal = r[SIGNED_IDX];
    var isBlank = signedVal !== true && signedVal !== false &&
      String(signedVal).trim().toUpperCase() !== 'TRUE' &&
      String(signedVal).trim().toUpperCase() !== 'FALSE';
    if (!isBlank) continue;

    var tebraStatus = String(r[TEBRA_IDX] || '');
    var expected = _expectedSignedValue(tebraStatus, r[DATE_IDX], r[TIME_IDX]);
    if (expected === false) {
      sheet.getRange(i + 1, SIGNED_COL).setValue(false);
      r[SIGNED_IDX] = false;  // keep in-memory copy in sync for pass 2
      summary.flipped++;
    }
  }

  // ── Pass 2: full UnsignedDates reconciliation, every provider+patient ──
  var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;
  var seen = {};
  for (var j = 1; j < rows.length; j++) {
    var row = rows[j];
    var provID = String(row[PROV_IDX] || '');
    var patName = String(row[PATIENT_IDX] || '').trim();
    if (!patName || PLACEHOLDER_NAMES.indexOf(patName.toUpperCase()) !== -1) continue;
    var patNorm = _normName(patName);
    var key = provID + '||' + patNorm;
    if (seen[key]) continue;
    seen[key] = true;

    var changed = _reconcilePatientUnsignedDates(sheet, rows, patNorm, provID);
    summary.cellsChanged += changed;
    summary.patientsReconciled++;
  }

  SpreadsheetApp.flush();

  var msg = 'nightlyReconcileUnsignedNotes: flipped ' + summary.flipped +
    ' blank Signed cells to FALSE, reconciled ' + summary.patientsReconciled +
    ' patients, changed ' + summary.cellsChanged + ' UnsignedDates cells.';
  Logger.log(msg);
  _audit(ss, 'UNSIGNED_RECONCILE', msg);

  return summary;
}

function getTotalUnsignedCount(prov) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ count: 0 });

    var PROV_IDX = APPT_COLS.indexOf('ProvID');        // 0  (col A)
    var TIME_IDX = APPT_COLS.indexOf('Time');          // 3  (col D)
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');        // 25 (col Z)
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');   // 34 (col AI)

    var rows = sheet.getDataRange().getValues();
    var count = 0;

    // Placeholder patients are calendar-block entries (personal day holds, room
    // blocks, etc.) and must never count toward unsigned note totals.
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      // Provider filter
      var rowProv = String(r[PROV_IDX] || '').trim();
      if (prov && rowProv !== String(prov).trim()) continue;

      // Skip placeholder patients (calendar blocks / personal day holds)
      if (PATIENT_IDX >= 0) {
        var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
        if (PLACEHOLDER_NAMES.indexOf(patName) !== -1) continue;
      }

      // Needs a signed note once its OWN date+time has passed — see
      // _isUnsignedEligible (2026-08-04). Not gated on TebraStatus reaching
      // "Confirmed" anymore; that silently under-counted real unsigned
      // visits whose Tebra status was never manually advanced.
      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      if (_isUnsignedEligible(tebraStatus, r[DATE_IDX], r[TIME_IDX], r[SIGNED_IDX])) count++;
    }

    return JSON.stringify({ count: count });
  } catch (e) {
    Logger.log('getTotalUnsignedCount ERROR: ' + e.message);
    return JSON.stringify({ count: 0, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: testUnsignedCountBreakdown — read-only, makes zero
// writes to any sheet. Breaks down exactly what getTotalUnsignedCount()
// / _isUnsignedEligible() are counting for one provider, to compare
// against a manual audit count. Run this from Apps Script and check
// the Logs (View → Logs) after running.
// ─────────────────────────────────────────────────────────────────
function testUnsignedCountBreakdown(provID, auditStartStr, auditEndStr) {
  provID = provID || 'jodene';
  auditStartStr = auditStartStr || '2026-01-01';
  auditEndStr = auditEndStr || '2026-08-26';

  Logger.log('── testUnsignedCountBreakdown for provID="' + provID + '" ' +
    '(audit window ' + auditStartStr + ' → ' + auditEndStr + ') ──────────');

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('❌  No Appointments sheet found (or it has no data rows).');
      return;
    }

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var TIME_IDX = APPT_COLS.indexOf('Time');
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

    var rows = sheet.getDataRange().getValues();

    // Bucket 1 — Signed value, among counted rows only
    var signedBlank = 0, signedFalse = 0, signedOther = 0;
    var otherSignedSamples = [];

    // Bucket 2 — inside/outside Dean's audited date window
    var inWindow = 0, outsideWindow = 0;

    // Bucket 3 — TebraStatus shape, among counted rows only
    var statusRecognized = 0, statusBlank = 0, statusOther = 0;
    var otherStatusSamples = [];

    var totalCounted = 0;
    var falseOnlyCount = 0;      // adjusted (a): literal FALSE only, excludes blanks
    var windowOnlyCount = 0;     // adjusted (b): audited window only, regardless of Signed shape

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      // Provider filter — this row must belong to provID and no other,
      // same guard getTotalUnsignedCount() itself uses.
      var rowProv = String(r[PROV_IDX] || '').trim();
      if (rowProv !== String(provID).trim()) continue;

      // Skip placeholder patients (calendar blocks / personal day holds) —
      // same exclusion getTotalUnsignedCount() applies, so "total counted"
      // below lines up with the live badge's own number.
      if (PATIENT_IDX >= 0) {
        var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
        if (PLACEHOLDER_NAMES.indexOf(patName) !== -1) continue;
      }

      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      var signedVal = r[SIGNED_IDX];
      var dateStr = _fmtDate(r[DATE_IDX]);

      if (!_isUnsignedEligible(tebraStatus, r[DATE_IDX], r[TIME_IDX], signedVal)) continue;

      totalCounted++;

      // ── Bucket 1: Signed value shape ──
      var signedStr = String(signedVal).trim().toUpperCase();
      if (signedVal === '' || signedVal === null || signedVal === undefined) {
        signedBlank++;
      } else if (signedVal === false || signedStr === 'FALSE') {
        signedFalse++;
        falseOnlyCount++;
      } else {
        signedOther++;
        if (otherSignedSamples.length < 10) {
          otherSignedSamples.push('row ' + (i + 1) + ': ' + JSON.stringify(signedVal));
        }
      }

      // ── Bucket 2: audited date window ──
      if (dateStr && dateStr >= auditStartStr && dateStr <= auditEndStr) {
        inWindow++;
        windowOnlyCount++;
      } else {
        outsideWindow++;
      }

      // ── Bucket 3: TebraStatus shape ──
      var normStatus = _normalizeStatusWord(tebraStatus);
      if (tebraStatus === '') {
        statusBlank++;
      } else if (normStatus === 'scheduled' || _isConfirmedStatus(tebraStatus) || _isCheckedOutStatus(tebraStatus)) {
        statusRecognized++;
      } else {
        statusOther++;
        if (otherStatusSamples.length < 10) {
          otherStatusSamples.push('row ' + (i + 1) + ': "' + tebraStatus + '"');
        }
      }
    }

    Logger.log('── Bucket 1: Signed value breakdown ──');
    Logger.log('  Blank/empty:        ' + signedBlank);
    Logger.log('  Literal FALSE:      ' + signedFalse);
    Logger.log('  Other unexpected:   ' + signedOther);
    if (otherSignedSamples.length) {
      Logger.log('  Other-value samples (up to 10):');
      otherSignedSamples.forEach(function (s) { Logger.log('    ' + s); });
    }

    Logger.log('── Bucket 2: audited date window (' + auditStartStr + ' → ' + auditEndStr + ') ──');
    Logger.log('  Inside window:      ' + inWindow);
    Logger.log('  Outside window:     ' + outsideWindow +
      '  (today\'s already-occurred appts, or anything before ' + auditStartStr + ')');

    Logger.log('── Bucket 3: TebraStatus breakdown (counted rows only) ──');
    Logger.log('  Recognized non-void: ' + statusRecognized + '  (Scheduled/Confirmed/Checked Out)');
    Logger.log('  Blank/empty:         ' + statusBlank);
    Logger.log('  Other (unrecognized):' + statusOther);
    if (otherStatusSamples.length) {
      Logger.log('  Other-status samples (up to 10):');
      otherStatusSamples.forEach(function (s) { Logger.log('    ' + s); });
    }

    Logger.log('── Summary ──');
    Logger.log('  Total counted (matches the live badge today): ' + totalCounted);
    Logger.log('  Adjusted (a) literal FALSE only, excl. blanks: ' + falseOnlyCount);
    Logger.log('  Adjusted (b) audited window only (' + auditStartStr + '–' + auditEndStr + '): ' + windowOnlyCount);
    Logger.log('  (Bonus) both restrictions combined:            ' +
      (function () {
        var both = 0;
        for (var j = 1; j < rows.length; j++) {
          var rr = rows[j];
          if (String(rr[PROV_IDX] || '').trim() !== String(provID).trim()) continue;
          if (PATIENT_IDX >= 0 && PLACEHOLDER_NAMES.indexOf(String(rr[PATIENT_IDX] || '').trim().toUpperCase()) !== -1) continue;
          var ts = TEBRA_IDX >= 0 ? String(rr[TEBRA_IDX] || '') : '';
          var sv = rr[SIGNED_IDX];
          if (!_isUnsignedEligible(ts, rr[DATE_IDX], rr[TIME_IDX], sv)) continue;
          var svStr = String(sv).trim().toUpperCase();
          var isLiteralFalse = sv === false || svStr === 'FALSE';
          var ds = _fmtDate(rr[DATE_IDX]);
          var inW = ds && ds >= auditStartStr && ds <= auditEndStr;
          if (isLiteralFalse && inW) both++;
        }
        return both;
      })());
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: testUnsignedDuplicateGroups — read-only, makes zero
// writes to any sheet. Groups one provider's counted-as-unsigned rows
// by the SAME identity (date + time + patient, normalized) that
// deduplicateAppointments() itself groups by — _fmtDate +
// _normalizeTimeKey for date/time, _stripMiddleName + lowercase for
// patient — so this reuses the sync's own matching rule rather than
// inventing a separate one. Run this from Apps Script and check the
// Logs (View → Logs) after running.
// ─────────────────────────────────────────────────────────────────
function testUnsignedDuplicateGroups(provID) {
  provID = provID || 'jodene';

  Logger.log('── testUnsignedDuplicateGroups for provID="' + provID + '" ──────────');

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('❌  No Appointments sheet found (or it has no data rows).');
      return;
    }

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var TIME_IDX = APPT_COLS.indexOf('Time');
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

    var rows = sheet.getDataRange().getValues();

    // groupKey (date||time||ptNorm) → array of { rowNum, dateStr, timeStr,
    // patient, tebraStatus, signedVal }
    var groups = {};
    var totalRows = 0;

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      var rowProv = String(r[PROV_IDX] || '').trim();
      if (rowProv !== String(provID).trim()) continue;

      if (PATIENT_IDX >= 0) {
        var patNameCheck = String(r[PATIENT_IDX] || '').trim().toUpperCase();
        if (PLACEHOLDER_NAMES.indexOf(patNameCheck) !== -1) continue;
      }

      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      var signedVal = r[SIGNED_IDX];

      if (!_isUnsignedEligible(tebraStatus, r[DATE_IDX], r[TIME_IDX], signedVal)) continue;

      totalRows++;

      var dateStr = _fmtDate(r[DATE_IDX]);
      var timeStr = _normalizeTimeKey(r[TIME_IDX]);
      var patient = String(r[PATIENT_IDX] || '').trim();
      var ptNorm = _stripMiddleName(patient).toLowerCase().replace(/\s+/g, ' ').trim();
      var groupKey = dateStr + '||' + timeStr + '||' + ptNorm;

      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push({
        rowNum: i + 1,
        dateStr: dateStr,
        timeStr: timeStr,
        patient: patient,
        tebraStatus: tebraStatus,
        signedVal: signedVal,
      });
    }

    var distinctGroups = Object.keys(groups).length;
    var dupGroupCount = 0;
    var dupRowCount = 0;

    Logger.log('── Groups with more than one row ──');
    Object.keys(groups).forEach(function (key) {
      var entries = groups[key];
      if (entries.length < 2) return;
      dupGroupCount++;
      dupRowCount += entries.length;

      var initials = _initialsFor(entries[0].patient);
      Logger.log('  🔀 ' + entries[0].dateStr + ' ' + entries[0].timeStr +
        '  "' + initials + '"  (' + entries.length + ' rows)');
      entries.forEach(function (e) {
        Logger.log('      row ' + e.rowNum +
          ': TebraStatus="' + e.tebraStatus + '"' +
          '  Signed=' + JSON.stringify(e.signedVal));
      });
    });
    if (dupGroupCount === 0) {
      Logger.log('  (none found)');
    }

    Logger.log('── Summary ──');
    Logger.log('  Total counted-as-unsigned rows: ' + totalRows);
    Logger.log('  Distinct identity groups:       ' + distinctGroups);
    Logger.log('  Groups with duplicates:         ' + dupGroupCount +
      '  (' + dupRowCount + ' rows across them, ' +
      (dupRowCount - dupGroupCount) + ' of which are extra beyond one-per-group)');
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

// Redacted "F.L." initials from a full name — first letter of the first
// token + first letter of the last token, uppercased. Used only for log
// output so a patient's full name never appears in the Apps Script log.
function _initialsFor(fullName) {
  var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  var first = parts[0].charAt(0).toUpperCase();
  var last = parts[parts.length - 1].charAt(0).toUpperCase();
  return parts.length === 1 ? (first + '.') : (first + '.' + last + '.');
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: testUnsignedRowList — read-only, makes zero writes to
// any sheet. Raw row-by-row list of every row _isUnsignedEligible()
// currently counts for one provider — no buckets, no analysis — so it
// can be checked directly against filtering the live sheet by hand.
// Run this from Apps Script and check the Logs (View → Logs) after
// running.
// ─────────────────────────────────────────────────────────────────
function testUnsignedRowList(provID) {
  provID = provID || 'jodene';

  Logger.log('── testUnsignedRowList for provID="' + provID + '" ──────────');

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('❌  No Appointments sheet found (or it has no data rows).');
      return;
    }

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var TIME_IDX = APPT_COLS.indexOf('Time');
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

    var rows = sheet.getDataRange().getValues();
    var count = 0;

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      var rowProv = String(r[PROV_IDX] || '').trim();
      if (rowProv !== String(provID).trim()) continue;

      if (PATIENT_IDX >= 0) {
        var patNameCheck = String(r[PATIENT_IDX] || '').trim().toUpperCase();
        if (PLACEHOLDER_NAMES.indexOf(patNameCheck) !== -1) continue;
      }

      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      var signedVal = r[SIGNED_IDX];

      if (!_isUnsignedEligible(tebraStatus, r[DATE_IDX], r[TIME_IDX], signedVal)) continue;

      count++;
      var dateStr = _fmtDate(r[DATE_IDX]);
      var timeStr = _fmtTime(r[TIME_IDX]);
      var patient = String(r[PATIENT_IDX] || '').trim();
      Logger.log('  row ' + (i + 1) + ':  ' + dateStr + '  ' + timeStr + '  "' + _initialsFor(patient) + '"');
    }

    Logger.log('── Total: ' + count + ' rows ──');
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

/* ════════════════════════════════════════════════════════════════════
   OVERDUE DIRECT-PAY COLLECTIONS — getOverdueDirectPay
   ════════════════════════════════════════════════════════════════════
   Scans every direct-pay appointment (BillingChannel === 'direct') for
   an uncollected copay / coinsurance / cash-pay / deductible balance
   whose appointment date is 30+ days in the past. Powers the header-
   level "Cost Share Overdue" alert so a biller sees it regardless of
   which window/date they're currently viewing — mirrors
   getTotalUnsignedCount()'s cross-date scan pattern.

   A row counts only if: method is direct, the visit actually occurred
   (same _visitOccurred rule as unsigned-note counting), the patient
   isn't a placeholder/calendar-block row, PaymentCollected isn't TRUE,
   and CostShareRate is set to a genuine non-zero value (blank/$0 rows
   have nothing to collect, so they're excluded — same rule the Billing
   Day view's DirectPaySection already uses via isZeroRate()).
   ════════════════════════════════════════════════════════════════════ */
function getOverdueDirectPay() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ items: [] });

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var METHOD_IDX = APPT_COLS.indexOf('BillingChannel');
    var TYPE_IDX = APPT_COLS.indexOf('CostShareClass');
    var RATE_IDX = APPT_COLS.indexOf('CostShareRate');
    var COLLECTED_IDX = APPT_COLS.indexOf('PaymentCollected');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var STATE_IDX = APPT_COLS.indexOf('PatientState');

    var tz = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var rows = sheet.getDataRange().getValues();
    var items = [];
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      if (String(r[METHOD_IDX] || '') !== 'direct') continue;

      var collected = r[COLLECTED_IDX];
      var isCollected = collected === true || String(collected).trim().toUpperCase() === 'TRUE';
      if (isCollected) continue;

      // Genuine, non-zero rate only — blank or $0/0% rows have nothing to
      // collect (same rule as the frontend's isZeroRate()).
      var rawRate = r[RATE_IDX];
      if (rawRate === null || rawRate === undefined || rawRate === '') continue;
      var rateNum = parseFloat(String(rawRate).replace(/[$%,\s]/g, ''));
      if (isNaN(rateNum) || rateNum === 0) continue;

      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      if (!_visitOccurred(tebraStatus)) continue;

      var patName = String(r[PATIENT_IDX] || '').trim();
      if (PLACEHOLDER_NAMES.indexOf(patName.toUpperCase()) !== -1) continue;

      var rowDate = _fmtDate(r[DATE_IDX]);
      if (!rowDate) continue;
      var ageDays = Math.floor((new Date(today) - new Date(rowDate)) / 86400000);
      if (ageDays < 30) continue;

      items.push({
        provID: String(r[PROV_IDX] || ''),
        patient: patName,
        patientState: STATE_IDX >= 0 ? String(r[STATE_IDX] || '') : '',
        date: rowDate,
        paymentType: String(r[TYPE_IDX] || ''),
        rate: String(rawRate),
        daysSince: ageDays,
      });
    }

    items.sort(function (a, b) { return b.daysSince - a.daysSince; });
    return JSON.stringify({ items: items });
  } catch (e) {
    Logger.log('getOverdueDirectPay ERROR: ' + e.message);
    return JSON.stringify({ items: [], error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════════
   auditAndFixUnsignedNotes (2026-08-04) — Dean's explicit request for a
   full reconcile-and-cleanup pass, not a read-only report. Scans EVERY
   row in the Appointments sheet and, for both Signed (col Z) and
   UnsignedDates (col V), corrects any cell that doesn't match what the
   main tool's own rule would produce (_expectedSignedValue /
   _isUnsignedEligible — the exact same functions saveAppointment,
   signNoteAndClearUnsigned, and the nightly sweep all use, so this
   audit can never drift from the live behavior the way the old V1
   audit and the live badge once did).

   Rules applied (never violated):
     • An existing Signed = TRUE is NEVER downgraded — this function only
       ever writes TRUE by preserving it, never by inferring it.
     • Signed is corrected to blank/FALSE per _expectedSignedValue when it
       doesn't already match (covers rows stuck wrongly blank, wrongly
       FALSE before their time, or wrongly FALSE on a void appointment).
     • UnsignedDates is fully recomputed per provider+patient group from
       the (now-corrected) Signed/TebraStatus/date state of every row in
       that group, exactly like _reconcilePatientUnsignedDates.

   Produces a detailed before/after report on a fresh 'UnsignedNotesFix'
   tab (red tab, grand-total summary, full correction tables) — this is
   NOT read-only, unlike auditUnsignedNotesV2 above.

   HOW TO RUN:
     1. Apps Script editor → function dropdown → auditAndFixUnsignedNotes
     2. Click ▶ Run
     3. Check the 'UnsignedNotesFix' tab and Logger output for results.

   Idempotent — a second run on an already-correct sheet finds nothing
   to change and reports zero corrections.
════════════════════════════════════════════════════════════════════ */
function auditAndFixUnsignedNotes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('auditAndFixUnsignedNotes: no appointment data found.');
    return JSON.stringify({ ok: true, signedCorrections: 0, unsignedDatesCorrections: 0 });
  }

  var PROV_IDX = APPT_COLS.indexOf('ProvID');
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var TIME_IDX = APPT_COLS.indexOf('Time');
  var APPTID_IDX = APPT_COLS.indexOf('ApptID');
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');
  var SIGNED_IDX = APPT_COLS.indexOf('Signed');
  var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
  var UNSIGNED_IDX = APPT_COLS.indexOf('UnsignedDates');
  var SIGNED_COL = SIGNED_IDX + 1;
  var UNSIGNED_COL = UNSIGNED_IDX + 1;

  var rows = sheet.getDataRange().getValues();
  var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;

  // ── Pass 1: correct Signed (col Z) ──────────────────────────────────
  var signedCorrections = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    var patName = String(r[PATIENT_IDX] || '').trim();
    if (!patName || PLACEHOLDER_NAMES.indexOf(patName.toUpperCase()) !== -1) continue;

    var currentSigned = r[SIGNED_IDX];
    var isTrue = currentSigned === true || String(currentSigned).trim().toUpperCase() === 'TRUE';
    var tebraStatus = String(r[TEBRA_IDX] || '');

    var expectedSigned = isTrue ? true : _expectedSignedValue(tebraStatus, r[DATE_IDX], r[TIME_IDX]);
    var normalizedCurrent = isTrue ? true :
      (currentSigned === false || String(currentSigned).trim().toUpperCase() === 'FALSE' ? false : '');

    if (normalizedCurrent !== expectedSigned) {
      sheet.getRange(i + 1, SIGNED_COL).setValue(expectedSigned);
      r[SIGNED_IDX] = expectedSigned;  // keep in-memory copy in sync for pass 2
      signedCorrections.push({
        row: i + 1,
        patient: patName,
        prov: String(r[PROV_IDX] || ''),
        date: _fmtDate(r[DATE_IDX]),
        apptId: String(r[APPTID_IDX] || ''),
        tebraStatus: tebraStatus.trim() || '(blank)',
        from: normalizedCurrent === '' ? '(blank)' : String(normalizedCurrent).toUpperCase(),
        to: expectedSigned === '' ? '(blank)' : String(expectedSigned).toUpperCase(),
      });
    }
  }

  // ── Pass 2: correct UnsignedDates (col V), per provider+patient group ──
  var unsignedDatesCorrections = [];
  var seen = {};
  for (var j = 1; j < rows.length; j++) {
    var row0 = rows[j];
    var patName0 = String(row0[PATIENT_IDX] || '').trim();
    if (!patName0 || PLACEHOLDER_NAMES.indexOf(patName0.toUpperCase()) !== -1) continue;
    var provID = String(row0[PROV_IDX] || '');
    var patNorm = _normName(patName0);
    var key = provID + '||' + patNorm;
    if (seen[key]) continue;
    seen[key] = true;

    var matches = [];
    for (var k = 1; k < rows.length; k++) {
      var r2 = rows[k];
      if (String(r2[PROV_IDX] || '') !== provID) continue;
      if (_normName(String(r2[PATIENT_IDX] || '')) !== patNorm) continue;
      matches.push({
        sheetRow: k + 1,
        apptId: String(r2[APPTID_IDX] || ''),
        date: _fmtDate(r2[DATE_IDX]),
        time: r2[TIME_IDX],
        tebraStatus: String(r2[TEBRA_IDX] || ''),
        signed: r2[SIGNED_IDX],
        currentV: String(r2[UNSIGNED_IDX] || ''),
      });
    }
    if (matches.length === 0) continue;

    var outstandingDates = matches
      .filter(function (m) { return m.date && _isUnsignedEligible(m.tebraStatus, m.date, m.time, m.signed); })
      .map(function (m) { return m.date; });

    matches.forEach(function (m) {
      if (!m.date) return;
      var priorDates = outstandingDates.filter(function (d) { return d < m.date; }).sort();
      var expectedV = priorDates.map(_toUnsignedDateStr).join(',');
      if (expectedV !== m.currentV) {
        sheet.getRange(m.sheetRow, UNSIGNED_COL).setValue(expectedV);
        unsignedDatesCorrections.push({
          row: m.sheetRow,
          patient: patName0,
          prov: provID,
          date: m.date,
          apptId: m.apptId,
          from: m.currentV || '(blank)',
          to: expectedV || '(blank)',
        });
      }
    });
  }

  SpreadsheetApp.flush();

  // ── Write report to a fresh 'UnsignedNotesFix' tab ──
  var reportName = 'UnsignedNotesFix';
  var existing = ss.getSheetByName(reportName);
  if (existing) ss.deleteSheet(existing);
  var report = ss.insertSheet(reportName);
  report.setTabColor('#DC2626');

  var out = [];
  var boldRows = [];
  function pushHeader(text) {
    boldRows.push(out.length);
    out.push([text]);
  }

  pushHeader('Unsigned Notes Audit & Fix — generated ' + new Date().toLocaleString());
  out.push(['This report MAKES CORRECTIONS to the Appointments tab — it is not read-only.']);
  out.push(['Rule: an existing Signed = TRUE is never downgraded. Everything else is corrected to match the live tool\'s own rule.']);
  out.push([]);

  pushHeader('GRAND TOTAL');
  out.push(['Rows scanned', rows.length - 1]);
  out.push(['Signed (col Z) corrections', signedCorrections.length]);
  out.push(['UnsignedDates (col V) corrections', unsignedDatesCorrections.length]);
  out.push([]);

  pushHeader('Signed corrections');
  out.push(['Patient', 'Date', 'Provider', 'ApptID', 'TebraStatus', 'From', 'To']);
  signedCorrections
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
    .forEach(function (c) {
      out.push([c.patient, c.date, c.prov, c.apptId, c.tebraStatus, c.from, c.to]);
    });
  out.push([]);

  pushHeader('UnsignedDates corrections');
  out.push(['Patient', 'Date', 'Provider', 'ApptID', 'Old Value', 'New Value']);
  unsignedDatesCorrections
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
    .forEach(function (c) {
      out.push([c.patient, c.date, c.prov, c.apptId, c.from, c.to]);
    });

  var maxCols = out.reduce(function (m, row) { return Math.max(m, row.length); }, 1);
  out.forEach(function (row) { while (row.length < maxCols) row.push(''); });

  report.getRange(1, 1, out.length, maxCols).setValues(out);
  boldRows.forEach(function (idx) {
    report.getRange(idx + 1, 1, 1, maxCols).setFontWeight('bold').setBackground('#F2EDDB');
  });
  report.getRange(1, 1, 1, maxCols).setFontSize(13);
  report.setFrozenRows(0);
  report.autoResizeColumns(1, maxCols);

  var summaryMsg = 'auditAndFixUnsignedNotes: scanned ' + (rows.length - 1) +
    ' rows | Signed corrections = ' + signedCorrections.length +
    ' | UnsignedDates corrections = ' + unsignedDatesCorrections.length +
    '. See the "UnsignedNotesFix" tab.';
  Logger.log(summaryMsg);
  _audit(ss, 'UNSIGNED_AUDIT_FIX', summaryMsg);

  return JSON.stringify({
    ok: true,
    signedCorrections: signedCorrections.length,
    unsignedDatesCorrections: unsignedDatesCorrections.length,
  });
}

/**
 * Converts typed date strings to 'YYYY-MM-DD' for reliable comparison.
 */
function _normalizeDateStr(d) {
  if (d === null || d === undefined || d === '') return '';

  // Date object — use the script's local timezone (already how _fmtDate works)
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return '';
    return _fmtDate(d);
  }

  var s = String(d).trim();
  if (!s) return '';

  // Already ISO "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // "M/D/YY" or "MM/DD/YYYY" etc.
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    var yr = m[3].length === 2 ? '20' + m[3] : m[3];
    var mo = ('0' + m[1]).slice(-2);
    var dy = ('0' + m[2]).slice(-2);
    return yr + '-' + mo + '-' + dy;
  }

  // Anything else parseable by JS ("Tue Mar 16 2026 ...", ISO w/ time, etc.)
  try {
    var dt = new Date(s);
    if (!isNaN(dt.getTime())) return _fmtDate(dt);
  } catch (e) { }

  return s;
}


/* ════════════════════════════════════════════════════════════════
   DELETE — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function deleteAppointment(apptId) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ error: 'No appointments found' });

    const values = sheet.getDataRange().getValues();
    let targetRow = -1;
    let patientName = '';
    let apptDate = '';
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][2]) === String(apptId)) {
        targetRow = i + 1;
        patientName = values[i][4] || '';
        apptDate = _fmtDate(values[i][1]);
        break;
      }
    }

    if (targetRow < 0) return JSON.stringify({ error: 'Appointment not found: ' + apptId });

    sheet.deleteRow(targetRow);
    _audit(ss, 'DELETE', `${patientName} | ${apptDate} | ${apptId}`);
    SpreadsheetApp.flush();
    return JSON.stringify({ ok: true });
  } catch (e) {
    Logger.log('deleteAppointment error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   READ — PATIENTS
════════════════════════════════════════════════════════════════ */

function getPatients() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    return JSON.stringify(
      sheet.getDataRange().getValues().slice(1)
        .map(r => ({
          firstName: String(r[0] || '').trim(),
          lastName: String(r[1] || '').trim(),
          platform: String(r[2] || '').trim(),
          insurance: String(r[3] || '').trim(),
          patientPortion: String(r[4] || '').trim(),
          rate: _sv(r[5]).trim(),   // _sv preserves numeric 0 ($0 copay)
          claimPlatform: String(r[6] || '').trim(),
          memberID: String(r[7] || '').trim(),
          // Sheets stores manually-entered dates as Date objects; convert to YYYY-MM-DD
          memberDOB: r[8] instanceof Date
            ? Utilities.formatDate(r[8], Session.getScriptTimeZone(), 'yyyy-MM-dd')
            : String(r[8] || '').trim(),
          pcn: String(r[9] || '').trim(),
          groupNumber: String(r[10] || '').trim(),
          primarySubscriber: String(r[11] || '').trim(),
          patientState: String(r[12] || '').trim(),
          renderingNPI: String(r[13] || '').trim(),
          billingNPI: String(r[14] || '').trim(),
          xCode: String(r[15] || '').trim(),
          paymentPlatform: String(r[16] || '').trim(),  // default collection platform
        }))
        .filter(p => p.firstName || p.lastName)
    );
  } catch (e) {
    Logger.log('getPatients error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   PATIENT COUNTS BY PROVIDER
   Replaces the earlier Rendering-NPI-based estimate, which undercounted
   badly since most claims aren't filed through Tebra (so most patients
   never get a renderingNPI saved). This instead counts distinct patients
   directly off the Appointments tab: Column A (ProvID) + Column E
   (Patient), deduped per provider so a patient seen 20 times only counts
   once. Header-driven (uses APPT_COLS.indexOf), not hardcoded column
   letters, so it stays correct if columns are ever reordered.
   Returns JSON: { "<provID>": <distinct patient count>, ... }
════════════════════════════════════════════════════════════════ */
function getPatientCountsByProvider() {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({});

    var colProv = APPT_COLS.indexOf('ProvID');
    var colPatient = APPT_COLS.indexOf('Patient');
    if (colProv === -1 || colPatient === -1) {
      return JSON.stringify({ error: 'ProvID/Patient not found in APPT_COLS' });
    }

    var numCols = Math.max(colProv, colPatient) + 1;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(numCols, sheet.getLastColumn())).getValues();

    // seen[provID] = Set-like object of patient names already counted for that provider
    var seen = {};
    data.forEach(function (row) {
      var provID = String(row[colProv] || '').trim().toLowerCase();
      var patient = String(row[colPatient] || '').trim().toLowerCase();
      if (!provID || !patient) return;
      if (!seen[provID]) seen[provID] = {};
      seen[provID][patient] = true;
    });

    var counts = {};
    Object.keys(seen).forEach(function (provID) {
      counts[provID] = Object.keys(seen[provID]).length;
    });
    return JSON.stringify(counts);
  } catch (e) {
    Logger.log('getPatientCountsByProvider error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   NOTE BOARD
   Returns appointments from 60 days back up to today (no future
   appointments) — the Note Board tracks post-encounter note status,
   which only applies to past and current appointments.
   Pass provFilter = '' for all providers, or a provider ID to
   restrict to that provider's rows.
════════════════════════════════════════════════════════════════ */
function getNoteBoard(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    var data = sheet.getDataRange().getValues();
    var hdr = data[0];

    var tz = Session.getScriptTimeZone();
    var today = new Date();
    var start = new Date(today); start.setDate(today.getDate() - 60); // 2 months back
    var startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    var endStr = Utilities.formatDate(today, tz, 'yyyy-MM-dd');        // today only — no future

    var PLACEHOLDER_NAMES_NB = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var appt = rowToAppt(r);
      if (!appt.id || !appt.date) continue;
      if (appt.date < startStr || appt.date > endStr) continue;
      if (provFilter && provFilter !== '' && appt.provID !== provFilter) continue;
      // Skip placeholder patients (calendar blocks / personal day holds)
      if (PLACEHOLDER_NAMES_NB.indexOf(String(appt.patient || '').trim().toUpperCase()) !== -1) continue;
      out.push({
        id: appt.id,
        date: appt.date,
        time: appt.time,
        patient: appt.patient,
        provID: appt.provID,
        noteStatus: appt.noteStatus || '',
        signed: appt.out || false,
        // Standalone columns (66-69) — read directly by number, not via
        // rowToAppt, since they're deliberately kept out of APPT_COLS.
        noteInProgressBy: String(r[NOTE_PROGRESS_BY_COL - 1] || ''),
        noteInProgressAt: String(r[NOTE_PROGRESS_AT_COL - 1] || ''),
        noteReadyBy: String(r[NOTE_READY_BY_COL - 1] || ''),
        noteReadyAt: String(r[NOTE_READY_AT_COL - 1] || ''),
      });
    }
    // Sort by date then time
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });
    return JSON.stringify(out);
  } catch (e) {
    Logger.log('getNoteBoard ERROR: ' + e.message);
    return JSON.stringify([]);
  }
}

/* ─────────────────────────────────────────────────────────────────
   SAVE NOTE STATUS
   Lightweight update — writes only the NoteStatus column for a
   given appointment ID. Called by the Note Board panel so assistants
   can update note status without a full appointment save.
   Also stamps who made the In Progress / Ready transition and when,
   into the standalone attribution columns (66-69, NOTE_PROGRESS_BY_COL
   through NOTE_READY_AT_COL) — captured server-side from the session, never from the client, so
   it can't be spoofed or mistyped. These columns are intentionally
   outside APPT_COLS (see the comment above NOTE_PROGRESS_BY_COL) so
   a normal full-appointment save never touches them.
────────────────────────────────────────────────────────────────── */
function saveNoteStatus(apptId, noteStatus) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var data = sheet.getDataRange().getValues();
    var ID_IDX = APPT_COLS.indexOf('ApptID');     // column C (index 2)
    var NS_IDX = APPT_COLS.indexOf('NoteStatus'); // column index 55
    if (NS_IDX < 0) return JSON.stringify({ ok: false, err: 'NoteStatus column not found' });

    var email = Session.getActiveUser().getEmail();
    var staff = _getStaffRecord(ss, email);
    var who = (staff && staff.initials) ? staff.initials : (staff && staff.displayName) ? staff.displayName : email;
    var now = new Date().toISOString();

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ID_IDX] || '').trim() === String(apptId).trim()) {
        var rowNum = i + 1;
        sheet.getRange(rowNum, NS_IDX + 1).setValue(noteStatus || '');

        if (noteStatus === 'in_progress') {
          sheet.getRange(rowNum, NOTE_PROGRESS_BY_COL).setValue(who);
          sheet.getRange(rowNum, NOTE_PROGRESS_AT_COL).setValue(now);
        } else if (noteStatus === 'ready') {
          sheet.getRange(rowNum, NOTE_READY_BY_COL).setValue(who);
          sheet.getRange(rowNum, NOTE_READY_AT_COL).setValue(now);
        } else {
          // Reset to Not Started — clear both stamps so the badge doesn't
          // show stale attribution from a previous pass at this note.
          sheet.getRange(rowNum, NOTE_PROGRESS_BY_COL).setValue('');
          sheet.getRange(rowNum, NOTE_PROGRESS_AT_COL).setValue('');
          sheet.getRange(rowNum, NOTE_READY_BY_COL).setValue('');
          sheet.getRange(rowNum, NOTE_READY_AT_COL).setValue('');
        }

        _audit(ss, 'NOTE_STATUS_UPDATED',
          'Appt ' + apptId + ' → noteStatus=' + (noteStatus || '(cleared)') + ' by ' + email);
        // {ok, at, by} — same shape as every other A1/A2 save function, so
        // callers don't need a special case for this one. "by" is who made
        // the change either way, even when clearing back to Not Started.
        return JSON.stringify({ ok: true, at: now, by: who });
      }
    }
    return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });
  } catch (e) {
    Logger.log('saveNoteStatus ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ─────────────────────────────────────────────────────────────────
   OVERRIDE NOTE ATTRIBUTION
   Lets an assistant correct who gets credit for a note-status
   transition (e.g. the wrong person got picked by mistake). This
   does NOT touch the note status itself, and only writes to the
   standalone columns 66-69 — never APPT_COLS. Every correction is
   itself audited (old value, new value, who made the correction).
   `which` must be 'inProgress' or 'ready'.
────────────────────────────────────────────────────────────────── */
function overrideNoteAttribution(apptId, which, staffEmail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });

    var BY_COL = which === 'inProgress' ? NOTE_PROGRESS_BY_COL : which === 'ready' ? NOTE_READY_BY_COL : null;
    if (!BY_COL) return JSON.stringify({ ok: false, err: 'Invalid attribution target: ' + which });

    var staff = _getStaffRecord(ss, staffEmail);
    var who = staff ? staff.displayName : staffEmail;

    var data = sheet.getDataRange().getValues();
    var ID_IDX = APPT_COLS.indexOf('ApptID');

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ID_IDX] || '').trim() === String(apptId).trim()) {
        var oldVal = String(data[i][BY_COL - 1] || '(blank)');
        sheet.getRange(i + 1, BY_COL).setValue(who);
        _audit(ss, 'NOTE_ATTRIBUTION_CORRECTED',
          'Appt ' + apptId + ' → col ' + BY_COL + ': "' + oldVal + '" → "' + who + '" (corrected by ' + Session.getActiveUser().getEmail() + ')');
        return JSON.stringify({ ok: true });
      }
    }
    return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });
  } catch (e) {
    Logger.log('overrideNoteAttribution ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ─────────────────────────────────────────────────────────────────
   GET ASSISTANT LIST
   Returns [{ email, displayName }] for every Staff-tab row with
   role='assistant' — used to populate the correction dropdown on
   the Note Board so a mis-attributed note can be reassigned.
────────────────────────────────────────────────────────────────── */
function getAssistantList() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_STAFF);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    var rows = sheet.getDataRange().getValues().slice(1);
    var out = rows
      .filter(function (r) { return String(r[1] || '').trim() === 'assistant'; })
      .map(function (r) {
        return { email: String(r[0] || '').trim(), displayName: String(r[3] || '').trim() };
      });
    return JSON.stringify(out);
  } catch (e) {
    Logger.log('getAssistantList ERROR: ' + e.message);
    return JSON.stringify([]);
  }
}


/* ════════════════════════════════════════════════════════════════
   CLAIMS LEDGER
   Returns all appointment rows that have a ClaimSubmittedDate,
   optionally filtered to a specific provider (pass '*' for all).
   Each record is the full rowToAppt object plus memberID and carrier
   joined from the Patients tab.
════════════════════════════════════════════════════════════════ */
function getClaimsLedger(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patSheet = ss.getSheetByName(TAB_PATIENT);
    if (!apptSheet || apptSheet.getLastRow() < 2) return JSON.stringify([]);

    // ── Build patient lookup: fullName (lowercase) → { memberID, insurance, claimPlatform }
    var patLookup = {};
    if (patSheet && patSheet.getLastRow() >= 2) {
      patSheet.getDataRange().getValues().slice(1).forEach(function (r) {
        var fname = String(r[0] || '').trim();
        var lname = String(r[1] || '').trim();
        if (!fname && !lname) return;
        var key = (fname + ' ' + lname).toLowerCase().replace(/\s+/g, ' ').trim();
        patLookup[key] = {
          memberID: String(r[7] || '').trim(),
          insurance: String(r[3] || '').trim(),
          claimPlatform: String(r[6] || '').trim(),
        };
      });
    }

    // ── Filter and enrich appointment rows
    var rows = apptSheet.getDataRange().getValues().slice(1);
    var claims = [];

    rows.forEach(function (r) {
      // Only include rows where a claim has been submitted
      var submittedDate = String(r[39] || '').trim();
      if (!submittedDate) return;

      var rowProv = String(r[0] || '');
      if (provFilter && provFilter !== '*' && rowProv !== provFilter) return;

      var appt = rowToAppt(r);

      // ── Only Clinic Submit (direct) appointments belong in the Claims Ledger ──
      // Source of truth: Method column (col F, index 5). Platform-billed appointments
      // (Alma, Headway, Grow) are excluded regardless of whether they have a submitted date.
      if (appt.method !== 'direct') return;

      var ptKey = _normName(appt.patient);
      var ptInfo = patLookup[ptKey] || {};

      // Insurance carrier: appointment's directIns takes priority, then patient record
      var carrier = appt.directIns || ptInfo.insurance || 'Other';

      claims.push({
        provID: appt.provID,
        id: appt.id,
        patient: appt.patient,
        patientState: appt.patientState,
        memberID: ptInfo.memberID || '',
        carrier: carrier,
        date: appt.date,
        cpt: appt.cpt,
        claimSubmittedDate: appt.claimSubmittedDate,
        claimPlatform: ptInfo.claimPlatform || '',
        claimID: appt.claimID,
        claimStatus: appt.claimStatus,
        claimStatusNotes: appt.claimStatusNotes,
        claimPaidDate: appt.claimPaidDate,
        claimPaidAmount: appt.claimPaidAmount,
        claimCheckID: appt.claimCheckID,
        claimERA: appt.claimERA,
        claimBundled: appt.claimBundled,
        claimBundledAmount: appt.claimBundledAmount,
        claimDepositBank: appt.claimDepositBank,
        claimDepositDate: appt.claimDepositDate,
        claimDepositAmount: appt.claimDepositAmount,
        // Copay info for Copay/Notes column
        paymentType: appt.paymentType,
        paymentRate: appt.paymentRate,
        paymentCollected: appt.paymentCollected,
        paymentFailed: appt.paymentFailed,
        paymentAmount: appt.paymentAmount,
        paymentDate: appt.paymentDate,
        // PPC (Payment Processing Channel) — added for the Copay/Notes column
        // rebuild; already stored per-appointment via rowToAppt, just wasn't
        // surfaced to the Claims Ledger before.
        paymentPlatform: appt.paymentPlatform,
      });
    });

    // Sort: by carrier, then patient name, then appointment date ascending
    claims.sort(function (a, b) {
      if (a.carrier < b.carrier) return -1;
      if (a.carrier > b.carrier) return 1;
      var pA = _normName(a.patient), pB = _normName(b.patient);
      if (pA < pB) return -1;
      if (pA > pB) return 1;
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return 0;
    });

    return JSON.stringify(claims);
  } catch (e) {
    Logger.log('getClaimsLedger error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   SAVE CLAIM NOTES
   Targeted single-field update for the Claims Ledger notes cell.
   Only touches ClaimStatusInfo (col AQ, 0-based index 42).
════════════════════════════════════════════════════════════════ */
function saveClaimNotes(provId, dateStr, apptId, notes) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet) return JSON.stringify({ error: 'Appointments sheet not found' });

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      // Match by ApptID (index 2) — unique identifier — with ProvID (index 0) as guard
      if (String(r[2]) === String(apptId) && String(r[0]) === String(provId)) {
        // ClaimStatusInfo is APPT_COLS index 42 → spreadsheet column 43 (1-based)
        sheet.getRange(i + 1, APPT_COLS.indexOf('ClaimStatusInfo') + 1)
          .setValue(notes || '');
        return JSON.stringify({ ok: true });
      }
    }
    return JSON.stringify({ error: 'Appointment not found' });
  } catch (e) {
    Logger.log('saveClaimNotes error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   PAYMENT TRACKER
   ════════════════════════════════════════════════════════════════
   Merges two sources: "SolBoard Auto" (main Appointments tab rows
   with a Cost-Share Collection entry) and "Legacy Import"/"Manual
   Entry" (PaymentTrackerManual tab). Comments is the one field
   that's editable regardless of source — savePaymentComment below
   writes the Appointments tab's own Comments column (BL) for
   SolBoard Auto rows; savePaymentManualComment further down writes
   PaymentTrackerManual's own Comments column for the other two.

   SolBoard Auto's comments field lives at column BL (index 64), intentionally
   standalone and NOT part of APPT_COLS. Columns 60-63 (BH-BK) hold
   3 dead duplicate headers (ScrData/ScrNote/ChecklistNote —
   confirmed empty, see auditColumnAlignment() run 2026-08-02) and a
   real PatientID column written by the separate patient-id-system's
   nightly Tebra sync — not by SolBoard. Every normal appointment
   save rewrites a contiguous block exactly as wide as APPT_COLS;
   keeping this column out of that array means ordinary saves never
   touch it, or anything from column 60 onward.
════════════════════════════════════════════════════════════════ */
var PAYMENT_COMMENTS_COL = 64;

/* ── NOTE STATUS ATTRIBUTION — standalone columns, same reasoning as
   PAYMENT_COMMENTS_COL above. Columns 60-64 are the documented
   reserved zone (3 dead headers, the external system's live PatientID
   column, and the Payment Tracker Comments column) — after the
   2026-08-05 incident where extending APPT_COLS into that zone
   collided with it, these live at 66-69 instead, with column 65 left
   as a buffer. Read/written directly by column number in
   saveNoteStatus/overrideNoteAttribution/getNoteBoard — intentionally
   NOT part of APPT_COLS, so ordinary appointment saves never touch
   them. Confirmed empty via inspectAppointmentColumns() on 2026-08-05
   before first use. ── */
var NOTE_PROGRESS_BY_COL = 66;  // BN
var NOTE_PROGRESS_AT_COL = 67;  // BO
var NOTE_READY_BY_COL = 68;     // BP
var NOTE_READY_AT_COL = 69;     // BQ

/* ── APPOINTMENT FLOW ATTRIBUTION (Stage 1, 2026-08-09) — standalone
   columns, same reasoning as NOTE_PROGRESS_BY_COL etc. above. Column 65
   is the existing buffer; these pick up immediately after the Note
   Status attribution block (66-69), starting at 70. Each pair is
   session-stamped server-side (never client-supplied) by its own
   dedicated save function, and — like the Note Status columns — kept
   OUT of APPT_COLS so an ordinary full-row appointment save never
   touches them. Confirmed empty by grepping this file for any
   reference to columns 65 or ≥70 before first use; no
   inspectAppointmentColumns()-equivalent tool exists in this codebase
   to re-verify against the live sheet directly, so re-check the sheet
   itself if this ever looks wrong. ── */
var STATUS_BY_COL = 70;                // BR — Status (Valid/Issue/In Process)
var STATUS_AT_COL = 71;                // BS
var CCEHR_BY_COL = 72;                 // BT — Credit Card on File in Tebra
var CCEHR_AT_COL = 73;                 // BU
var CLAIM_STATUS_BY_COL = 74;          // BV
var CLAIM_STATUS_AT_COL = 75;          // BW
var CLAIM_SUBMITTED_BY_COL = 76;       // BX — who/when the submission was recorded;
var CLAIM_SUBMITTED_AT_COL = 77;       // BY   distinct from the ClaimSubmittedDate business field
var NOTE_SIGNED_BY_COL = 78;           // BZ — distinct from the Signed boolean itself
var NOTE_SIGNED_AT_COL = 79;           // CA
var SCR_DATA_BY_COL = 80;              // CB — last-edited by/at for the whole
var SCR_DATA_AT_COL = 81;              // CC   ScrData blob, not per individual score
var BEST_RATE_CONFIRMED_COL = 82;      // CD — HVA confirmed the auto-computed
var BEST_RATE_CONFIRMED_BY_COL = 83;   // CE   best-channel recommendation
var BEST_RATE_CONFIRMED_AT_COL = 84;   // CF
/* ── UNSIGNED-CONFIRMED ATTRIBUTION — RESERVED (unused). Columns 85-87
   (CG-CI) held UNSIGNED_CONFIRMED_COL/BY_COL/AT_COL and
   saveUnsignedConfirmed() — a fully-built, never-activated feature
   (no frontend caller ever existed for the save path, and rowToAppt's
   read of it was equally unconsumed). Removed 2026-08-28. Left
   reserved rather than reused for a new column: the live Sheet's
   header cells (CG1/CH1/CI1) still read UnsignedConfirmed/By/At and
   were deliberately left untouched, same as ChecklistNote's own
   orphaned header — reconcile those cells before ever reusing 85-87. ── */

/* ── PRE-VISIT CHECKLIST ATTRIBUTION (2026-08-10) — Intake/InsVerified/
   Autopay/ChecklistNote never had any by/at tracking at all before this;
   these are new columns, not previously-unexposed old ones. Assistant-
   entered, pre-visit, matches the same _stampAttribution pattern as
   everything above. ── */
var INTAKE_BY_COL = 88;                // CJ
var INTAKE_AT_COL = 89;                // CK
var INS_VERIFIED_BY_COL = 90;          // CL
var INS_VERIFIED_AT_COL = 91;          // CM
var AUTOPAY_BY_COL = 92;               // CN
var AUTOPAY_AT_COL = 93;               // CO
var CHECKLIST_NOTE_BY_COL = 94;        // CP
var CHECKLIST_NOTE_AT_COL = 95;        // CQ

/* ─/* ── TEBRA SOURCE ID (2026-08-16) — standalone column, same reasoning
   as PAYMENT_COMMENTS_COL / NOTE_PROGRESS_BY_COL etc. above. Holds the
   raw Tebra appointment ID (e.g. "11022LCS" — NOT the same as ApptID,
   which is SolBoard's own generated identifier). Previously this ID
   was only embedded as text inside Notes ("Imported from Tebra API
   (ID:xxxxx)"), which broke reconciliation any time billing staff
   overwrote Notes with their own working notes — routine, and the
   root cause of the 2026-08-16 legacy-orphan investigation (32 rows
   found unrecoverable from Notes alone). Storing it here decouples
   sync-integrity tracking from a user-editable field permanently.
   Column 95 (CQ) is the last currently-used standalone column; this
   picks up right after it. Written ONLY by the Tebra import's
   row-creation path and the one-time backfill below — never by any
   manual save. Confirm empty via verifyTebraSourceIdColEmpty() before
   first use. ── */
var TEBRA_SOURCE_ID_COL = 96;  // CR

/* ── INSURANCE CARRIER MANUAL OVERRIDE (2026-08-26) — standalone by/at
   pair, same _stampAttribution() shape as STATUS_BY_COL etc. above, but
   this is the first standalone pair used PROTECTIVELY rather than just
   for display attribution: every sync-side write to Appointments.
   InsuranceCarrier (the main import loop's DirectIns write,
   backfillInsuranceCarrier(), and syncPatientStates()' Appointments-tab
   write) checks INSURANCE_CARRIER_MANUAL_AT_COL first and skips
   entirely — not "newer wins," permanently — once a human has set the
   value via ProvChannelModal or BillerApptModal. Column 96 (CR) is the
   last currently-used standalone column; this picks up right after it.
   Patients.InsuranceCarrier is NOT covered by this pair — it has no
   equivalent standalone-attribution convention on that sheet at all,
   and is out of scope for this stage. ── */
var INSURANCE_CARRIER_MANUAL_BY_COL = 97;  // CS
var INSURANCE_CARRIER_MANUAL_AT_COL = 98;  // CT

/* ── INTAKE UPDATES (2026-08-27) — standalone column, same reasoning as
   TEBRA_SOURCE_ID_COL / PAYMENT_COMMENTS_COL etc. above. Holds a
   JSON-stringified array of {date, time, author, note} entries — the
   Assistant-written successor to ScrNote/ChecklistNote's single-value
   "Provider Notes" field, but supporting multiple, individually-
   attributed entries over time instead of one overwritten string. No
   separate by/at pair needed: each entry already carries its own
   author/date/time internally, the same way Comms (Messages) already
   does — this mirrors that exact JSON-array-on-one-column pattern, not
   the by/at-pair pattern used elsewhere in this block. Column 98 (CT)
   is the last currently-used standalone column; this picks up right
   after it. ── */
var INTAKE_UPDATES_COL = 99;  // CU

/* ── TEBRA PATIENT ID (2026-08-17) — standalone column. Repurposes BH
   (60), one of four columns an earlier comment described as "3 dead
   duplicate headers + a real PatientID column written by the separate
   patient-id-system's nightly Tebra sync." Verified against live sheet
   data before reuse: all four columns (BH-BK / 60-63) were completely
   empty across all 2,342 rows — patient_id_system's own handoff doc
   confirms its Google service account is Viewer-only and can never
   write to this sheet, so that old comment was describing something
   that was never actually happening. BI/BJ/BK (61-63) remain reserved.
   Holds the real Tebra internal Patient ID — PHI, same handling
   discipline as anywhere else patient identifiers appear. Written on
   row creation for now; backfilling existing rows is a follow-up. ── */
var TEBRA_PATIENT_ID_COL = 60;  // BH

/* ── Attribution stamp helper — writes the current session's staff
   displayName (or raw email if unrecognized) plus an ISO timestamp
   into a by/at column pair. Shared by every save function below so
   the who/when logic can't drift between them. Session-derived only,
   same as saveNoteStatus — never takes who/when from the client. ── */
function _stampAttribution(ss, sheet, rowNum, byCol, atCol) {
  var email = Session.getActiveUser().getEmail();
  var staff = _getStaffRecord(ss, email);
  var who = (staff && staff.initials) ? staff.initials : (staff && staff.displayName) ? staff.displayName : email;
  var now = new Date().toISOString();
  sheet.getRange(rowNum, byCol).setValue(who);
  sheet.getRange(rowNum, atCol).setValue(now);
  return { who: who, now: now };
}

/** 1-based sheet row for a given ApptID, or -1 if not found. */
function _findApptRow(sheet, apptId) {
  var data = sheet.getDataRange().getValues();
  var idN = String(apptId || '').trim();
  var ID_IDX = APPT_COLS.indexOf('ApptID');
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][ID_IDX] || '').trim() === idN) return i + 1;
  }
  return -1;
}

/* ── Appointment Status (Valid/Issue/In Process) attribution ─────────── */
function saveAppointmentStatus(apptId, status) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('Status') + 1).setValue(status || '');
    var attrib = _stampAttribution(ss, sheet, rowNum, STATUS_BY_COL, STATUS_AT_COL);
    var now = attrib.now;

    _audit(ss, 'STATUS_UPDATED', 'Appt ' + apptId + ' → status=' + (status || '(cleared)'));
    return JSON.stringify({ ok: true, at: now });
  } catch (e) {
    Logger.log('saveAppointmentStatus ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── CCEHR (Credit Card on File in Tebra) — carry-forward (A2) ─────────
   One edit event writes CCEHR to the triggering appointment AND every
   other CURRENT/FUTURE appointment for that same patient, across ALL
   providers (no ProvID filter) — a patient's CC-on-file status doesn't
   vary by provider or visit. The triggering row always gets written
   regardless of its own date (Table View's window reaches 7 days into
   the past, so the row someone actually clicked must always save, same
   as the old single-row saveCCEHR did); the carry-forward scan to every
   OTHER matching row is gated on date >= today — past appointments are
   never touched by the scan. who/now are computed ONCE (via
   _stampAttribution on the triggering row) and reused verbatim for
   every other row this touches, since this is conceptually one action,
   not many separate edits with their own timestamps.
   This replaces saveCCEHR entirely — that function's only caller
   (Appointment Flow's Table View CC toggle) now calls this instead, and
   the old single-row function added nothing this one doesn't already
   do for the single-appointment case (a patient with no other
   qualifying appointments just writes the one triggering row). ────── */
function saveCCEHRCarryForward(apptId, value) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });

    var data = sheet.getDataRange().getValues();
    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var ID_IDX = APPT_COLS.indexOf('ApptID');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var CCEHR_COL = APPT_COLS.indexOf('CCEHR') + 1;

    var triggerRowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ID_IDX] || '').trim() === String(apptId).trim()) { triggerRowIdx = i; break; }
    }
    if (triggerRowIdx < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    var patientNorm = _normName(String(data[triggerRowIdx][PATIENT_IDX] || ''));
    var todayStr = _fmtDate(new Date());

    // Triggering row — always written, reuses _stampAttribution's existing
    // who-derivation rather than duplicating it; its {who, now} is then
    // reused as-is for every other row below.
    sheet.getRange(triggerRowIdx + 1, CCEHR_COL).setValue(value || '');
    var attrib = _stampAttribution(ss, sheet, triggerRowIdx + 1, CCEHR_BY_COL, CCEHR_AT_COL);

    var updated = [{
      id: String(data[triggerRowIdx][ID_IDX] || ''),
      date: _fmtDate(data[triggerRowIdx][DATE_IDX]),
      provID: String(data[triggerRowIdx][PROV_IDX] || ''),
    }];

    for (var r = 1; r < data.length; r++) {
      if (r === triggerRowIdx) continue; // already written above
      if (_normName(String(data[r][PATIENT_IDX] || '')) !== patientNorm) continue;
      var dateStr = _fmtDate(data[r][DATE_IDX]);
      if (!dateStr || dateStr < todayStr) continue; // past — never touched

      var rowNum = r + 1;
      sheet.getRange(rowNum, CCEHR_COL).setValue(value || '');
      sheet.getRange(rowNum, CCEHR_BY_COL).setValue(attrib.who);
      sheet.getRange(rowNum, CCEHR_AT_COL).setValue(attrib.now);
      updated.push({
        id: String(data[r][ID_IDX] || ''),
        date: dateStr,
        provID: String(data[r][PROV_IDX] || ''),
      });
    }

    _audit(ss, 'CCEHR_CARRY_FORWARD', 'Patient "' + data[triggerRowIdx][PATIENT_IDX] + '" → ccEhr=' +
      (value || '(cleared)') + ' across ' + updated.length + ' appointment(s)');
    return JSON.stringify({ ok: true, at: attrib.now, by: attrib.who, updated: updated });
  } catch (e) {
    Logger.log('saveCCEHRCarryForward ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── ClaimStatus attribution ───────────────────────────────────────────── */
function saveClaimStatus(apptId, claimStatus) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('ClaimStatus') + 1).setValue(claimStatus || '');
    var attrib = _stampAttribution(ss, sheet, rowNum, CLAIM_STATUS_BY_COL, CLAIM_STATUS_AT_COL);
    var now = attrib.now;

    _audit(ss, 'CLAIM_STATUS_UPDATED', 'Appt ' + apptId + ' → claimStatus=' + (claimStatus || '(cleared)'));
    return JSON.stringify({ ok: true, at: now });
  } catch (e) {
    Logger.log('saveClaimStatus ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── Claim submission attribution — who/when the submission was recorded,
   distinct from the ClaimSubmittedDate business field itself (which this
   also writes, matching what ClaimSubmitModal currently sets via the
   full-row save). ──────────────────────────────────────────────────── */
function saveClaimSubmission(apptId, claimSubmittedDate) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('ClaimSubmittedDate') + 1).setValue(claimSubmittedDate || '');
    var attrib = _stampAttribution(ss, sheet, rowNum, CLAIM_SUBMITTED_BY_COL, CLAIM_SUBMITTED_AT_COL);
    var now = attrib.now;

    _audit(ss, 'CLAIM_SUBMITTED', 'Appt ' + apptId + ' → claimSubmittedDate=' + (claimSubmittedDate || '(cleared)'));
    return JSON.stringify({ ok: true, at: now });
  } catch (e) {
    Logger.log('saveClaimSubmission ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── Coordinated screener-score save (A3b) — writes the whole ScrData
   JSON blob AND, for any screener the caller says needs its tri-state
   flag flipped to true, the matching PHQ9/GAD7/PCL5 column too — one
   _stampAttribution call covers both, onto scrDataBy/At. scrFlagNames
   is caller-computed (mirrors PatientModal's updScrScore exactly: skip
   a screener if its flag already reads true — never touches an
   explicit false/null on its own). This replaces saveScrData, which
   had zero real callers (only ever reachable through the full-row save
   path PatientModal's updScrData/updScrScore actually use) and whose
   entire behavior — write ScrData, stamp scrDataBy/At — is now a
   strict subset of this one (an empty scrFlagNames array reduces to
   exactly what saveScrData did). ──────────────────────────────────── */
function saveScrEntry(apptId, scrDataJson, scrFlagNames) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('ScrData') + 1).setValue(scrDataJson || '');

    // Screener display name (as used in scrData/appt.scr) → its own
    // tri-state flag column — the same column rowToAppt() already reads
    // for appt.scr['PHQ-9']/['GAD-7']/['PCL-5'].
    var SCR_FLAG_COL = {
      'PHQ-9': APPT_COLS.indexOf('PHQ9') + 1,
      'GAD-7': APPT_COLS.indexOf('GAD7') + 1,
      'PCL-5': APPT_COLS.indexOf('PCL5') + 1,
    };
    (scrFlagNames || []).forEach(function (name) {
      var col = SCR_FLAG_COL[name];
      if (!col) return;
      var current = sheet.getRange(rowNum, col).getValue();
      if (current === true || current === 'TRUE') return; // already Done — no-op
      sheet.getRange(rowNum, col).setValue(true);
    });

    var attrib = _stampAttribution(ss, sheet, rowNum, SCR_DATA_BY_COL, SCR_DATA_AT_COL);

    _audit(ss, 'SCR_DATA_UPDATED', 'Appt ' + apptId +
      (scrFlagNames && scrFlagNames.length ? ' → flagged Done: ' + scrFlagNames.join(', ') : ''));
    return JSON.stringify({ ok: true, at: attrib.now, by: attrib.who });
  } catch (e) {
    Logger.log('saveScrEntry ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── Best-rate confirmation — an HVA explicitly confirming the
   auto-computed best-channel recommendation, separate from the
   recommendation itself (Patients sheet BestChannel column). ──────── */
function saveBestRateConfirmed(apptId, confirmed) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, BEST_RATE_CONFIRMED_COL).setValue(!!confirmed);
    var attrib = _stampAttribution(ss, sheet, rowNum, BEST_RATE_CONFIRMED_BY_COL, BEST_RATE_CONFIRMED_AT_COL);
    var now = attrib.now;

    _audit(ss, 'BEST_RATE_CONFIRMED', 'Appt ' + apptId + ' → confirmed=' + !!confirmed);
    return JSON.stringify({ ok: true, at: now, by: attrib.who });
  } catch (e) {
    Logger.log('saveBestRateConfirmed ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ── Pre-visit checklist attribution — Intake, InsVerified, Autopay,
   ChecklistNote. All four are assistant-entered in PatientModal before
   the appointment date; Table View surfaces whichever of these is an
   issue (value === false, or a non-empty note) in the appointment's own
   billing-channel column. ──────────────────────────────────────────── */
function saveIntake(apptId, value) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('Intake') + 1).setValue(value);
    var attrib = _stampAttribution(ss, sheet, rowNum, INTAKE_BY_COL, INTAKE_AT_COL);
    var now = attrib.now;

    _audit(ss, 'INTAKE_UPDATED', 'Appt ' + apptId + ' → intake=' + value);
    return JSON.stringify({ ok: true, at: now, by: attrib.who });
  } catch (e) {
    Logger.log('saveIntake ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

function saveInsVerified(apptId, value) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('InsVerified') + 1).setValue(value);
    var attrib = _stampAttribution(ss, sheet, rowNum, INS_VERIFIED_BY_COL, INS_VERIFIED_AT_COL);
    var now = attrib.now;

    _audit(ss, 'INS_VERIFIED_UPDATED', 'Appt ' + apptId + ' → ins=' + value);
    return JSON.stringify({ ok: true, at: now, by: attrib.who });
  } catch (e) {
    Logger.log('saveInsVerified ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

function saveAutopay(apptId, value) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('Autopay') + 1).setValue(value);
    var attrib = _stampAttribution(ss, sheet, rowNum, AUTOPAY_BY_COL, AUTOPAY_AT_COL);
    var now = attrib.now;

    _audit(ss, 'AUTOPAY_UPDATED', 'Appt ' + apptId + ' → autopay=' + value);
    return JSON.stringify({ ok: true, at: now, by: attrib.who });
  } catch (e) {
    Logger.log('saveAutopay ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

function saveChecklistNote(apptId, note) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var rowNum = _findApptRow(sheet, apptId);
    if (rowNum < 0) return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });

    sheet.getRange(rowNum, APPT_COLS.indexOf('ChecklistNote') + 1).setValue(note || '');
    var attrib = _stampAttribution(ss, sheet, rowNum, CHECKLIST_NOTE_BY_COL, CHECKLIST_NOTE_AT_COL);
    var now = attrib.now;

    _audit(ss, 'CHECKLIST_NOTE_UPDATED', 'Appt ' + apptId);
    return JSON.stringify({ ok: true, at: now });
  } catch (e) {
    Logger.log('saveChecklistNote ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
  }
}

/* ════════════════════════════════════════════════════════════════
   APPOINTMENT FLOW — LIVE WINDOW / ARCHIVE (Stage 1, 2026-08-09)
   ════════════════════════════════════════════════════════════════
   Shared bounds: for a given provider, the live window runs from that
   provider's oldest outstanding unsigned-note date (same eligibility
   test as getTotalUnsignedCount — see _isUnsignedEligible) through 14
   days from today. A provider with no outstanding unsigned notes has
   no historical floor, so their window simply starts today. An
   appointment whose claim has been submitted more than 1 day ago is
   excluded from the live window regardless of date — it's settled and
   belongs in the Archive instead. "More than 1 day ago" is measured
   from ClaimSubmittedDate — the pre-existing business-date field —
   deliberately NOT the new ClaimSubmittedAt attribution stamp, which
   is blank on historical data and would misjudge it. See the comment
   in _isInLiveWindow for the full reasoning.
 
   getLiveWindowAppointments and searchArchiveAppointments share the
   exact same bounds/exclusion logic (_liveWindowBounds / _isInLiveWindow)
   so the two views can never disagree about which side of the line a
   row falls on.
════════════════════════════════════════════════════════════════ */

/** Computes, per provider present in `data`, the oldest outstanding
 *  unsigned-note date, plus the shared today/horizon strings. */
function _liveWindowBounds(data, provFilter) {
  var PROV_IDX = APPT_COLS.indexOf('ProvID');
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var TIME_IDX = APPT_COLS.indexOf('Time');
  var SIGNED_IDX = APPT_COLS.indexOf('Signed');
  var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');
  var NS_IDX = APPT_COLS.indexOf('NoteStatus');
  var ID_IDX = APPT_COLS.indexOf('ApptID');

  var todayStr = _fmtDate(new Date());
  var horizon = new Date();
  horizon.setDate(horizon.getDate() + 14);
  var horizonStr = _fmtDate(horizon);

  var oldestUnsignedByProv = {};
  // Per-patient list of every currently-outstanding unsigned date (a patient
  // can have more than one), keyed exactly like _reconcilePatientUnsignedDates
  // does: provID + '||' + _normName(patient). Built in this same pass — same
  // eligibility check already being run per row for oldestUnsignedByProv — so
  // this costs zero additional full-sheet scans. Each entry carries that
  // date's own noteStatus + attribution (same field names _rowToApptWith
  // Attribution already uses) so a caller can show what stage each other
  // outstanding date is actually at, not just the bare date — plus its own
  // ApptID (A3a) so an edit made against ONE entry can be saved against
  // that specific appointment, not the row that happens to be displaying it.
  var unsignedDatesByPatientProv = {};
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var prov = String(r[PROV_IDX] || '').trim();
    if (!prov) continue;
    if (provFilter && provFilter !== '*' && prov !== provFilter) continue;

    // Placeholder patients (calendar blocks / personal day holds) never
    // count toward unsigned totals — same exclusion as getTotalUnsignedCount.
    var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
    if (PLACEHOLDER_PATIENT_NAMES.indexOf(patName) !== -1) continue;

    var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
    if (!_isUnsignedEligible(tebraStatus, r[DATE_IDX], r[TIME_IDX], r[SIGNED_IDX])) continue;

    var dateStr = _fmtDate(r[DATE_IDX]);
    if (!dateStr) continue;
    if (!oldestUnsignedByProv[prov] || dateStr < oldestUnsignedByProv[prov]) {
      oldestUnsignedByProv[prov] = dateStr;
    }

    var patientKey = prov + '||' + _normName(String(r[PATIENT_IDX] || ''));
    if (!unsignedDatesByPatientProv[patientKey]) unsignedDatesByPatientProv[patientKey] = [];
    unsignedDatesByPatientProv[patientKey].push({
      apptId: String(r[ID_IDX] || ''),
      date: dateStr,
      noteStatus: String(r[NS_IDX] || ''),
      noteInProgressBy: String(r[NOTE_PROGRESS_BY_COL - 1] || ''),
      noteInProgressAt: String(r[NOTE_PROGRESS_AT_COL - 1] || ''),
      noteReadyBy: String(r[NOTE_READY_BY_COL - 1] || ''),
      noteReadyAt: String(r[NOTE_READY_AT_COL - 1] || ''),
    });
  }

  Object.keys(unsignedDatesByPatientProv).forEach(function (k) {
    unsignedDatesByPatientProv[k].sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; // oldest first
    });
  });

  return {
    todayStr: todayStr,
    horizonStr: horizonStr,
    oldestUnsignedByProv: oldestUnsignedByProv,
    unsignedDatesByPatientProv: unsignedDatesByPatientProv,
  };
}

/** True if row `r` (0-based array, one row from getDataRange().getValues())
 *  falls inside the live window for its own provider. */
function _isInLiveWindow(r, bounds) {
  var PROV_IDX = APPT_COLS.indexOf('ProvID');
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var CLAIM_SUBMITTED_DATE_IDX = APPT_COLS.indexOf('ClaimSubmittedDate');

  var prov = String(r[PROV_IDX] || '').trim();
  var dateStr = _fmtDate(r[DATE_IDX]);
  if (!prov || !dateStr) return false;

  var windowStart = bounds.oldestUnsignedByProv[prov] || bounds.todayStr;
  if (dateStr < windowStart || dateStr > bounds.horizonStr) return false;

  // Gated on ClaimSubmittedDate alone — NOT on ClaimStatus, and NOT on the new
  // ClaimSubmittedAt attribution stamp. ClaimSubmitModal's Submitted Date field
  // and Status dropdown are independent controls (crb_index.html handleSave /
  // buildFinalAppt) — a date can be saved via "Save" while Status is left on
  // "— Select —" (blank), so gating on ClaimStatus would let an old, genuinely
  // submitted claim with no status slip back into the live window. And
  // ClaimSubmittedAt is blank on every row that predates this feature or was
  // never re-touched through saveClaimSubmission(), so it can't be trusted
  // either. ClaimSubmittedDate is the one field guaranteed to be populated
  // wherever a claim was actually submitted, going back before this stage
  // existed.
  // Built directly from _fmtDate()'s own 'YYYY-MM-DD' output via manual split
  // + the multi-arg Date constructor — never re-parsed through new Date() on
  // the formatted string itself, which would hit the same UTC-midnight trap
  // fmtUnsignedDate had (date-only strings parse as UTC, then read back
  // shifted a day for any timezone behind UTC).
  var claimSubmittedStr = r[CLAIM_SUBMITTED_DATE_IDX] ? _fmtDate(r[CLAIM_SUBMITTED_DATE_IDX]) : '';
  var refDate = null;
  if (claimSubmittedStr) {
    var csParts = claimSubmittedStr.split('-').map(Number);
    refDate = new Date(csParts[0], csParts[1] - 1, csParts[2]);
  }
  if (refDate && !isNaN(refDate.getTime())) {
    var ageMs = new Date().getTime() - refDate.getTime();
    if (ageMs > 24 * 60 * 60 * 1000) return false; // submitted >1 day ago — settled, belongs in Archive
  }

  return true;
}

/* ════════════════════════════════════════════════════════════════
   APPOINTMENT FLOW — TABLE VIEW WINDOW (2026-08-10)
   ════════════════════════════════════════════════════════════════
   Deliberately independent of List's window (_liveWindowBounds /
   _isInLiveWindow above): a fixed backward bound (today - 7 days,
   NOT tied to any provider's oldest unsigned note) through a fixed
   forward bound (today + 14 days), pure date comparison — no
   claim-status exception. An appointment can be in List's window,
   Table's window, both, or neither; the two are no longer the same
   boolean anywhere downstream.
════════════════════════════════════════════════════════════════ */

/** Table View's fixed bounds. No `data` param — unlike List's bounds,
 *  nothing here depends on the sheet contents, only on today's date. */
function _tableWindowBounds() {
  var today = new Date();
  var backward = new Date(today);
  backward.setDate(backward.getDate() - 7);
  var forward = new Date(today);
  forward.setDate(forward.getDate() + 14);
  return {
    todayStr: _fmtDate(today),
    backwardBoundStr: _fmtDate(backward),
    forwardBoundStr: _fmtDate(forward),
  };
}

/** True if row `r`'s own date falls within Table's fixed window. */
function _isInTableWindow(r, tableBounds) {
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var dateStr = _fmtDate(r[DATE_IDX]);
  if (!dateStr) return false;
  return dateStr >= tableBounds.backwardBoundStr && dateStr <= tableBounds.forwardBoundStr;
}

/** Appointment Flow only — layers the Stage 1 attribution columns (70-87,
 *  intentionally outside APPT_COLS, see the block comment above
 *  STATUS_BY_COL) on top of the standard rowToAppt() shape. Kept as a
 *  separate function rather than extending rowToAppt() itself so every
 *  other view in the app (WeekView, AllProviderWeekView, AssistantView,
 *  ProviderView, BillingView, ClaimsLedger, getNoteBoard, etc.) doesn't
 *  carry this extra payload weight on every load — only
 *  getLiveWindowAppointments, getTableWindowAppointments, and
 *  searchArchiveAppointments call this. Takes both List's bounds and
 *  Table's bounds so every returned row carries both isInListWindow and
 *  isInTableWindow, independent of which function's own filter it
 *  passed to be included at all. */
function _rowToApptWithAttribution(r, bounds, tableBounds) {
  var appt = rowToAppt(r);
  appt.isInListWindow = _isInLiveWindow(r, bounds);
  appt.isInTableWindow = _isInTableWindow(r, tableBounds);
  var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
  var DATE_IDX = APPT_COLS.indexOf('Date');
  var TIME_IDX = APPT_COLS.indexOf('Time');
  var SIGNED_IDX = APPT_COLS.indexOf('Signed');
  appt.isUnsignedEligible = _isUnsignedEligible(String(r[TEBRA_IDX] || ''), r[DATE_IDX], r[TIME_IDX], r[SIGNED_IDX]);
  // Original Note Status attribution pair (columns 66-69, predates Stage 1) —
  // not new columns, just not previously exposed through this function.
  appt.noteInProgressBy = String(r[NOTE_PROGRESS_BY_COL - 1] || '');
  appt.noteInProgressAt = String(r[NOTE_PROGRESS_AT_COL - 1] || '');
  appt.noteReadyBy = String(r[NOTE_READY_BY_COL - 1] || '');
  appt.noteReadyAt = String(r[NOTE_READY_AT_COL - 1] || '');
  appt.statusBy = String(r[STATUS_BY_COL - 1] || '');
  appt.statusAt = String(r[STATUS_AT_COL - 1] || '');
  appt.ccEhrBy = String(r[CCEHR_BY_COL - 1] || '');
  appt.ccEhrAt = String(r[CCEHR_AT_COL - 1] || '');
  appt.claimStatusBy = String(r[CLAIM_STATUS_BY_COL - 1] || '');
  appt.claimStatusAt = String(r[CLAIM_STATUS_AT_COL - 1] || '');
  appt.claimSubmittedBy = String(r[CLAIM_SUBMITTED_BY_COL - 1] || '');
  appt.claimSubmittedAt = String(r[CLAIM_SUBMITTED_AT_COL - 1] || '');
  appt.noteSignedBy = String(r[NOTE_SIGNED_BY_COL - 1] || '');
  appt.noteSignedAt = String(r[NOTE_SIGNED_AT_COL - 1] || '');
  appt.scrDataBy = String(r[SCR_DATA_BY_COL - 1] || '');
  appt.scrDataAt = String(r[SCR_DATA_AT_COL - 1] || '');
  appt.bestRateConfirmed = r[BEST_RATE_CONFIRMED_COL - 1] === true || r[BEST_RATE_CONFIRMED_COL - 1] === 'TRUE';
  appt.bestRateConfirmedBy = String(r[BEST_RATE_CONFIRMED_BY_COL - 1] || '');
  appt.bestRateConfirmedAt = String(r[BEST_RATE_CONFIRMED_AT_COL - 1] || '');
  // Pre-visit checklist attribution — new columns, see the block comment
  // above INTAKE_BY_COL. appt.intake/ins/autopay/checklistNote themselves
  // already come from rowToAppt() above; these are just who/when.
  appt.intakeBy = String(r[INTAKE_BY_COL - 1] || '');
  appt.intakeAt = String(r[INTAKE_AT_COL - 1] || '');
  appt.insBy = String(r[INS_VERIFIED_BY_COL - 1] || '');
  appt.insAt = String(r[INS_VERIFIED_AT_COL - 1] || '');
  appt.autopayBy = String(r[AUTOPAY_BY_COL - 1] || '');
  appt.autopayAt = String(r[AUTOPAY_AT_COL - 1] || '');
  appt.checklistNoteBy = String(r[CHECKLIST_NOTE_BY_COL - 1] || '');
  appt.checklistNoteAt = String(r[CHECKLIST_NOTE_AT_COL - 1] || '');
  return appt;
}

/** Appointment Flow's main-view dataset: every appointment currently
 *  "live" for provFilter (or all providers if '' / omitted), per the
 *  bounds/exclusion rule documented above. */
function getLiveWindowAppointments(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ today: _fmtDate(new Date()), appointments: [] });

    var data = sheet.getDataRange().getValues();
    var bounds = _liveWindowBounds(data, provFilter);
    var tableBounds = _tableWindowBounds();
    var PROV_IDX = APPT_COLS.indexOf('ProvID');

    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var prov = String(r[PROV_IDX] || '').trim();
      if (!prov) continue;
      if (provFilter && provFilter !== '*' && prov !== provFilter) continue;
      if (!_isInLiveWindow(r, bounds)) continue;
      var appt = _rowToApptWithAttribution(r, bounds, tableBounds);
      appt.otherUnsignedDates = (bounds.unsignedDatesByPatientProv[prov + '||' + _normName(appt.patient)] || [])
        .filter(function (d) { return d.date !== appt.date; });
      out.push(appt);
    }

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });

    // Returns {today, appointments} rather than a bare array — the client
    // needs the server's own idea of "today" (America/New_York, per
    // appsscript.json) to classify pre- vs. post-visit rows, so it doesn't
    // have to compute its own via new Date() in the browser's local
    // timezone, which could disagree with the server near the day boundary.
    // Filtering/shape here is UNCHANGED from before this stage — still
    // List's window only — so nothing about what the already-shipped
    // frontend renders changes; each row now just also carries
    // isInListWindow/isInTableWindow (see _rowToApptWithAttribution).
    return JSON.stringify({ today: bounds.todayStr, appointments: out });
  } catch (e) {
    Logger.log('getLiveWindowAppointments ERROR: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/** Appointment Flow's Archive search — the complement of
 *  getLiveWindowAppointments: everything that falls OUTSIDE the live
 *  window per the exact same bounds/exclusion rule, optionally
 *  filtered by patient name (partial, case-insensitive) and/or an
 *  exact date (YYYY-MM-DD). */
function searchArchiveAppointments(patientName, dateStr, provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);

    var data = sheet.getDataRange().getValues();
    var bounds = _liveWindowBounds(data, provFilter);
    var tableBounds = _tableWindowBounds();

    var nameFilter = String(patientName || '').trim().toLowerCase();
    var dateFilter = String(dateStr || '').trim();
    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');

    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var prov = String(r[PROV_IDX] || '').trim();
      if (!prov) continue;
      if (provFilter && provFilter !== '*' && prov !== provFilter) continue;
      if (_isInLiveWindow(r, bounds)) continue; // still live — not archived

      if (nameFilter && String(r[PATIENT_IDX] || '').toLowerCase().indexOf(nameFilter) === -1) continue;
      if (dateFilter && _fmtDate(r[DATE_IDX]) !== dateFilter) continue;

      var appt = _rowToApptWithAttribution(r, bounds, tableBounds);
      appt.otherUnsignedDates = (bounds.unsignedDatesByPatientProv[prov + '||' + _normName(appt.patient)] || [])
        .filter(function (d) { return d.date !== appt.date; });
      out.push(appt);
    }

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date > b.date ? -1 : 1; // most recent first
      return a.time < b.time ? -1 : 1;
    });

    return JSON.stringify(out);
  } catch (e) {
    Logger.log('searchArchiveAppointments ERROR: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/** Table View's own dataset: every appointment within Table's fixed
 *  window (today - 7 days through today + 14 days), independent of
 *  List's window entirely — see the block comment above
 *  _tableWindowBounds. provFilter '' or omitted returns all providers.
 *  Each returned row carries both isInListWindow and isInTableWindow
 *  (isInTableWindow is always true here, by construction of the filter
 *  below; isInListWindow varies — a row can be in both). */
function getTableWindowAppointments(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      var emptyBounds = _tableWindowBounds();
      return JSON.stringify({
        today: emptyBounds.todayStr, backwardBound: emptyBounds.backwardBoundStr,
        forwardBound: emptyBounds.forwardBoundStr, appointments: [],
      });
    }

    var data = sheet.getDataRange().getValues();
    var bounds = _liveWindowBounds(data, provFilter);
    var tableBounds = _tableWindowBounds();
    var PROV_IDX = APPT_COLS.indexOf('ProvID');

    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      var prov = String(r[PROV_IDX] || '').trim();
      if (!prov) continue;
      if (provFilter && provFilter !== '*' && prov !== provFilter) continue;
      if (!_isInTableWindow(r, tableBounds)) continue;
      var appt = _rowToApptWithAttribution(r, bounds, tableBounds);
      appt.otherUnsignedDates = (bounds.unsignedDatesByPatientProv[prov + '||' + _normName(appt.patient)] || [])
        .filter(function (d) { return d.date !== appt.date; });
      out.push(appt);
    }

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });

    return JSON.stringify({
      today: tableBounds.todayStr,
      backwardBound: tableBounds.backwardBoundStr,
      forwardBound: tableBounds.forwardBoundStr,
      appointments: out,
    });
  } catch (e) {
    Logger.log('getTableWindowAppointments ERROR: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

function savePaymentComment(provId, dateStr, apptId, comment) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet) return JSON.stringify({ error: 'Appointments sheet not found' });

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      if (String(r[2]) === String(apptId) && String(r[0]) === String(provId)) {
        sheet.getRange(i + 1, PAYMENT_COMMENTS_COL).setValue(comment || '');
        return JSON.stringify({ ok: true });
      }
    }
    return JSON.stringify({ error: 'Appointment not found' });
  } catch (e) {
    Logger.log('savePaymentComment error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/* ── savePaymentManualComment — Comments column for PaymentTrackerManual
   (Legacy Import / Manual Entry rows) ────────────────────────────────────
   This tab has no ID column, so getPaymentTrackerManualData hands back
   each row's own sheet row number as `rowIndex` for the frontend to send
   back here. That number can drift if someone else inserts/deletes a row
   in this tab between load and save, so it's re-checked against the row's
   Patient (column C) before writing — a mismatch means the position moved
   and the save is rejected rather than risking a comment landing on the
   wrong patient's row.
──────────────────────────────────────────────────────────────────────── */
function savePaymentManualComment(rowIndex, patient, comment) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PAYMENT_MANUAL);
    if (!sheet) return JSON.stringify({ error: 'PaymentTrackerManual sheet not found' });

    var row = parseInt(rowIndex, 10);
    if (!row || row < 2 || row > sheet.getLastRow()) return JSON.stringify({ error: 'Invalid row' });

    var rowPatient = String(sheet.getRange(row, 3).getValue() || '').trim();
    if (rowPatient.toLowerCase() !== String(patient || '').trim().toLowerCase()) {
      return JSON.stringify({ error: 'Row has moved — refresh and try again' });
    }

    sheet.getRange(row, 14).setValue(comment || ''); // Comments column
    return JSON.stringify({ ok: true });
  } catch (e) {
    Logger.log('savePaymentManualComment error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

// provID everywhere in JS-land is the lowercase short id ('jodene'); the
// PaymentTrackerManual sheet's own convention (set by the original 252-row
// import) is a capitalized first name ('Jodene'). Only used at the write
// boundary — reads already normalize back to lowercase via
// getPaymentTrackerManualData.
function _ptProvDisplayName(provID) {
  var p = String(provID || '').trim();
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

/* ── addPaymentManualEntry — new hand-entered exception row ───────────────
   Appends a row to PaymentTrackerManual, always Source: 'Manual Entry'.
   Column order matches getPaymentTrackerManualData's read (see that
   function's header comment). Returns the row shaped the same way that
   function returns rows, so the frontend can splice it straight into its
   already-loaded list without a full refetch.
──────────────────────────────────────────────────────────────────────── */
function addPaymentManualEntry(entryJson) {
  try {
    var entry = JSON.parse(entryJson);
    var patient = String((entry && entry.patient) || '').trim();
    var provID = String((entry && entry.provID) || '').trim().toLowerCase();
    if (!patient) return JSON.stringify({ error: 'Patient name is required' });
    if (!provID) return JSON.stringify({ error: 'Provider is required' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PAYMENT_MANUAL);
    if (!sheet) return JSON.stringify({ error: 'PaymentTrackerManual sheet not found' });

    sheet.appendRow([
      entry.paymentDate || '',                 // PaymentDate
      _ptProvDisplayName(provID),               // ProvID
      patient,                                  // Patient
      entry.date || 'N/A',                      // ApptDate
      entry.cpt || '',                          // CPTCodes
      entry.paymentType || '',                  // CostShareClass (display label, e.g. "Copay")
      entry.paymentRate || '',                  // CostShareRate
      entry.paymentAmount || '',                // CostShareCollectedAmt
      entry.paymentCollected ? true : false,     // PaymentCollected
      entry.paymentFailed ? true : false,        // PaymentFailed
      entry.paymentPlatform || '',               // PaymentProcessingChannel
      entry.paymentPlan ? true : false,          // PaymentPlan
      entry.status || '',                        // Status
      entry.comments || '',                       // Comments
      'Manual Entry',                             // Source
      '',                                          // ImportNotes
    ]);
    var rowIndex = sheet.getLastRow();

    return JSON.stringify({
      ok: true,
      row: {
        source: 'Manual Entry',
        provID: provID,
        rowIndex: rowIndex,
        patient: patient,
        date: entry.date || 'N/A',
        cpt: entry.cpt ? String(entry.cpt).split(/[|,;]/).map(function (s) { return s.trim(); }).filter(Boolean) : [],
        paymentType: String(entry.paymentType || '').trim().toLowerCase().replace(/\s+/g, '-'),
        paymentRate: entry.paymentRate || '',
        paymentAmount: entry.paymentAmount || '',
        paymentCollected: !!entry.paymentCollected,
        paymentFailed: !!entry.paymentFailed,
        paymentDate: entry.paymentDate || '',
        paymentPlatform: entry.paymentPlatform || '',
        paymentPlan: entry.paymentPlan ? 'TRUE' : '',
        status: entry.status || '',
        comments: entry.comments || '',
        importNotes: '',
      }
    });
  } catch (e) {
    Logger.log('addPaymentManualEntry error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

// Sort key for Payment Tracker's `date` field. Most rows are clean ISO
// 'YYYY-MM-DD' strings and compare correctly against each other as plain
// strings — but PaymentTrackerManual has real rows where that field is
// "N/A", "payment plan", or even a comma-separated list of dates (a
// multi-appointment payment plan entry). Plain string comparison sorts
// those ABOVE every real date (letters/digits > any ISO date's leading
// "2...") or scatters them unpredictably (a date list starting "11/" sorts
// as if from 2011, not the actual — much more recent — dates it lists).
// Reducing anything non-ISO to '' means real dates sort correctly among
// themselves, and everything else groups predictably at the bottom
// instead of landing wherever string comparison accidentally puts it.
function _ptSortKey(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : '';
}

/* ── getPaymentTrackerData — "SolBoard Auto" rows only ────────────────────
   Same read pattern as getClaimsLedger: full sheet scan, rowToAppt() per
   row, filter, enrich, return JSON. Mirrors Claims Ledger's "direct-pay
   only" restriction (Cost-Share Collection is a Clinic-Submit concept —
   Alma/Headway/Grow copays aren't collected through SolBoard's own
   payment flow), and reuses _checkProvAccess exactly like saveAppointment
   does, so a provider-role caller can never pull another provider's rows
   by requesting a different provFilter — the same mechanism the "Jodene
   only" Payment Tracker button in the Provider window depends on.
──────────────────────────────────────────────────────────────────────── */
function getPaymentTrackerData(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (provFilter) {
      var deny = _checkProvAccess(ss, provFilter);
      if (deny) return deny;
    }

    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patSheet = ss.getSheetByName(TAB_PATIENT);
    if (!apptSheet || apptSheet.getLastRow() < 2) return JSON.stringify([]);

    // ── Forward cutoff: today + 5 calendar days, per Dean 2026-08-02 ──
    // ("today is August 2, display through August 7, nothing beyond that").
    // No lower bound — all past dates are in scope, only the future side
    // is capped, since a not-yet-happened visit can't have anything
    // collected against it yet.
    var tz = Session.getScriptTimeZone();
    var cutoffStr = Utilities.formatDate(new Date(Date.now() + 5 * 86400000), tz, 'yyyy-MM-dd');

    // ── Patient lookup: fullName (lowercase) → insurance carrier ──
    var patLookup = {};
    if (patSheet && patSheet.getLastRow() >= 2) {
      patSheet.getDataRange().getValues().slice(1).forEach(function (r) {
        var fname = String(r[0] || '').trim();
        var lname = String(r[1] || '').trim();
        if (!fname && !lname) return;
        var key = (fname + ' ' + lname).toLowerCase().replace(/\s+/g, ' ').trim();
        patLookup[key] = { insurance: String(r[3] || '').trim() };
      });
    }

    var rows = apptSheet.getDataRange().getValues();
    var out = [];

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      var rowProv = String(r[0] || '').trim().toLowerCase();
      if (provFilter && provFilter !== '*' && rowProv !== String(provFilter).toLowerCase()) continue;

      var appt = rowToAppt(r);

      // Only Clinic Submit (direct) appointments carry a Cost-Share
      // Collection entry — same rule Claims Ledger uses for claims.
      if (appt.method !== 'direct') continue;
      if (!appt.paymentType) continue;  // no Cost-Share Class set — nothing to track
      if (appt.date && appt.date > cutoffStr) continue;  // more than 5 days out
      if (_isZeroRate(appt.paymentRate)) continue;       // $0 copay — nothing to collect
      // No Show / Rescheduled / Cancelled / stale-Tebra-ID rows don't
      // represent a real visit and never show on the main SolBoard
      // calendar — same _isVoidStatus rule as everywhere else in the app
      // (unsigned-note counting, Tebra Sync reconciliation), applied here
      // per Dean 2026-08-03 so Payment Tracker matches that same behavior.
      if (_isVoidStatus(appt.tebraStatus)) continue;

      var ptKey = _normName(appt.patient);
      var ptInfo = patLookup[ptKey] || {};
      var insurance = appt.directIns || ptInfo.insurance || '';

      out.push({
        source: 'SolBoard Auto',
        provID: appt.provID,
        id: appt.id,
        date: appt.date,
        time: appt.time,
        patient: appt.patient,
        patientState: appt.patientState,
        insurance: insurance,
        cpt: appt.cpt,
        paymentType: appt.paymentType,       // Cost-Share Class
        paymentRate: appt.paymentRate,        // expected
        paymentAmount: appt.paymentAmount,       // collected amount
        paymentCollected: appt.paymentCollected,
        paymentFailed: appt.paymentFailed,
        paymentDate: appt.paymentDate,
        paymentPlatform: appt.paymentPlatform,    // Payment Processing Channel
        comments: String(r[PAYMENT_COMMENTS_COL - 1] || ''),
      });
    }

    // Most recently collected first
    out.sort(function (a, b) {
      var ka = _ptSortKey(a.date), kb = _ptSortKey(b.date);
      if (ka < kb) return 1;
      if (ka > kb) return -1;
      return _normName(a.patient) < _normName(b.patient) ? -1 : 1;
    });

    return JSON.stringify(out);
  } catch (e) {
    Logger.log('getPaymentTrackerData error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/* ── getPaymentTrackerManualData — PaymentTrackerManual tab ────────────────
   Legacy-import + hand-entered-exception rows. Column order (fixed, per
   the tab's own header row, confirmed 2026-08-02):
     0 PaymentDate    1 ProvID          2 Patient          3 ApptDate
     4 CPTCodes       5 CostShareClass  6 CostShareRate    7 CostShareCollectedAmt
     8 PaymentCollected  9 PaymentFailed  10 PaymentProcessingChannel
     11 PaymentPlan   12 Status         13 Comments        14 Source
     15 ImportNotes
 
   Output field names deliberately match getPaymentTrackerData()'s shape
   (patient, cpt, paymentType, paymentRate, paymentAmount, paymentPlatform,
   comments, ...) so the eventual merge is a straight concat, not a
   translation step. `source` is read from the tab's own Source column
   (Legacy Import / Manual Entry) rather than hardcoded, since both values
   already live there. No forward-date cutoff or $0-rate exclusion applied
   here yet — this tab is historical/exception data, not live scheduling,
   so neither of those main-tab rules obviously applies; holding off until
   we've seen real rows rather than guessing.
──────────────────────────────────────────────────────────────────────── */
function getPaymentTrackerManualData(provFilter) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (provFilter) {
      var deny = _checkProvAccess(ss, provFilter);
      if (deny) return deny;
    }

    var sheet = ss.getSheetByName(TAB_PAYMENT_MANUAL);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);

    var rows = sheet.getDataRange().getValues();
    var out = [];

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[2]) continue; // no Patient — skip blank rows

      // ── ProvID normalization ──────────────────────────────────────────
      // This tab stores "Jodene"/"Katie" (capitalized first names, per
      // Dean's original brief); the main tab and every other part of the
      // app (STAFF_SEED, PROVIDERS, _checkProvAccess) use lowercase
      // short strings ('jodene'/'katie'). Confirmed via live test
      // 2026-08-02. Normalize output to lowercase so both sources speak
      // the same convention downstream, and compare case-insensitively
      // so filtering isn't silently broken by the mismatch.
      var rowProv = String(r[1] || '').trim().toLowerCase();
      if (provFilter && provFilter !== '*' && rowProv !== String(provFilter).toLowerCase()) continue;

      var collectedRaw = r[8];
      var failedRaw = r[9];

      // Cost-Share Class here is stored as the display label ("Copay",
      // "Cash Pay") rather than the main tab's internal key
      // ('copay','cash-pay'). Normalize so both sources use the same
      // lowercase-hyphenated key (CSC_LABELS-style) for filtering/display.
      var paymentTypeRaw = String(r[5] || '').trim().toLowerCase().replace(/\s+/g, '-');

      out.push({
        source: String(r[14] || '').trim() || 'Manual Entry',
        provID: rowProv,
        rowIndex: i + 1,   // 1-based sheet row — this tab has no ID column, used by savePaymentManualComment
        patient: String(r[2] || '').trim(),
        date: _fmtDate(r[3]),   // ApptDate — same semantic as main-tab `date`
        cpt: r[4] ? String(r[4]).split(/[|,;]/).map(function (s) { return s.trim(); }).filter(Boolean) : [],
        paymentType: paymentTypeRaw,   // Cost-Share Class
        paymentRate: _sv(r[6]),                    // expected
        paymentAmount: _sv(r[7]),                    // collected amount
        paymentCollected: collectedRaw === true || String(collectedRaw).trim().toUpperCase() === 'TRUE',
        paymentFailed: failedRaw === true || String(failedRaw).trim().toUpperCase() === 'TRUE',
        paymentDate: _fmtDate(r[0]),
        paymentPlatform: String(r[10] || '').trim(),   // Payment Processing Channel
        paymentPlan: String(r[11] || '').trim(),
        status: String(r[12] || '').trim(),   // Paid / Declined / Reversed
        comments: String(r[13] || ''),
        importNotes: String(r[15] || ''),
      });
    }

    out.sort(function (a, b) {
      var ka = _ptSortKey(a.date), kb = _ptSortKey(b.date);
      if (ka < kb) return 1;
      if (ka > kb) return -1;
      return _normName(a.patient) < _normName(b.patient) ? -1 : 1;
    });

    return JSON.stringify(out);
  } catch (e) {
    Logger.log('getPaymentTrackerManualData error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/* ── getPaymentTrackerAll — combined ledger, both sources ─────────────────
   Calls getPaymentTrackerData (SolBoard Auto) and getPaymentTrackerManualData
   (Legacy Import / Manual Entry), concatenates, re-sorts. Both already
   apply _checkProvAccess with the same provFilter, so if a caller isn't
   allowed to see one source they aren't allowed to see the other either —
   if either sub-call comes back as a non-array (an access-denied or error
   object), that's propagated as-is rather than silently dropping half the
   ledger.
──────────────────────────────────────────────────────────────────────── */
function getPaymentTrackerAll(provFilter) {
  try {
    var autoData = JSON.parse(getPaymentTrackerData(provFilter));
    var manualData = JSON.parse(getPaymentTrackerManualData(provFilter));

    if (!Array.isArray(autoData)) return JSON.stringify(autoData);
    if (!Array.isArray(manualData)) return JSON.stringify(manualData);

    var out = autoData.concat(manualData);
    out.sort(function (a, b) {
      var ka = _ptSortKey(a.date), kb = _ptSortKey(b.date);
      if (ka < kb) return 1;
      if (ka > kb) return -1;
      return _normName(a.patient) < _normName(b.patient) ? -1 : 1;
    });

    return JSON.stringify(out);
  } catch (e) {
    Logger.log('getPaymentTrackerAll error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/* ── auditPaymentTrackerDuplicates — READ-ONLY diagnostic ─────────────────
   Dean's invariant: 1 patient + 1 provider + 1 appointment date = 1
   payment. Groups every row from both sources by normalized
   Patient+ProvID+ApptDate and logs any group with more than one row.
   Writes nothing — run manually (Apps Script editor ▶ Run) whenever
   duplicates are suspected, e.g. after a fresh legacy-sheet import.
──────────────────────────────────────────────────────────────────────── */
function auditPaymentTrackerDuplicates() {
  var autoRows = JSON.parse(getPaymentTrackerData(''));
  var manualRows = JSON.parse(getPaymentTrackerManualData(''));

  if (!Array.isArray(autoRows)) { Logger.log('getPaymentTrackerData error: ' + JSON.stringify(autoRows)); return; }
  if (!Array.isArray(manualRows)) { Logger.log('getPaymentTrackerManualData error: ' + JSON.stringify(manualRows)); return; }

  var all = autoRows.concat(manualRows);

  // Only real, single ISO dates carry meaning for this check — "N/A",
  // "payment plan", and multi-date payment-plan entries would otherwise
  // false-match every other row sharing the same non-date value.
  var groups = {};
  all.forEach(function (r) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return;
    var key = _normName(r.patient) + '|' + String(r.provID || '').toLowerCase() + '|' + r.date;
    (groups[key] = groups[key] || []).push(r);
  });

  var dupGroupCount = 0, dupRowCount = 0;
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (g.length < 2) return;
    dupGroupCount++;
    dupRowCount += g.length;
    Logger.log('── DUPLICATE: ' + key + ' (' + g.length + ' rows) ──');
    g.forEach(function (r) {
      Logger.log(
        '  source=' + r.source +
        ' id=' + (r.id || '') +
        ' rowIndex=' + (r.rowIndex || '') +
        ' amount=' + r.paymentAmount +
        ' collected=' + r.paymentCollected +
        ' failed=' + r.paymentFailed +
        ' status=' + (r.status || '') +
        ' paymentDate=' + r.paymentDate +
        ' comments=' + JSON.stringify(r.comments || '')
      );
    });
  });

  Logger.log('=== SUMMARY: ' + dupGroupCount + ' duplicate group(s), ' + dupRowCount + ' total rows involved ===');
}

/* ── cleanupPaymentTrackerDuplicates — deletes ONLY unambiguous duplicates
   ──────────────────────────────────────────────────────────────────────
   Investigated 2026-08-02 via auditPaymentTrackerDuplicates(): 105
   duplicate groups, 92 of them a clean pattern — SolBoard Auto (the main
   Appointments tab's own live Cost-Share Collection) and a Legacy Import
   row (PaymentTrackerManual, from the pre-Payment-Tracker manual tracking
   sheet) both recording the SAME real payment: same patient+provider+
   appointment-date, same collected amount, Legacy Import's Status='Paid'.
 
   The other 13 groups are NOT duplicates — declined-then-paid sequences,
   Reversed/refund rows, mismatched amounts, or a row where SolBoard
   Auto's own record is blank and the Legacy Import row is the only real
   record. This function only matches the narrow 92-pattern (exactly 2
   rows: 1 SolBoard Auto + 1 Legacy Import/Paid, amounts equal) — those 13
   are always left alone for manual review.
 
   Only ever deletes from PaymentTrackerManual — never writes to or
   deletes from the main Appointments tab, which stays the kept "live"
   copy. Grouping is computed fresh in this same run (not from a stale
   prior read), and each row's Patient is re-verified immediately before
   its delete in case the sheet shifted between the read and the write.
   Confirmed 2026-08-03: ran clean, deleted 92 of 92 candidates, second
   audit pass afterward showed exactly the 13 non-duplicate groups left.
──────────────────────────────────────────────────────────────────────── */
function cleanupPaymentTrackerDuplicates() {
  try {
    var autoRows = JSON.parse(getPaymentTrackerData(''));
    var manualRows = JSON.parse(getPaymentTrackerManualData(''));

    if (!Array.isArray(autoRows)) { Logger.log('getPaymentTrackerData error: ' + JSON.stringify(autoRows)); return; }
    if (!Array.isArray(manualRows)) { Logger.log('getPaymentTrackerManualData error: ' + JSON.stringify(manualRows)); return; }

    var groups = {};
    autoRows.concat(manualRows).forEach(function (r) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return;
      var key = _normName(r.patient) + '|' + String(r.provID || '').toLowerCase() + '|' + r.date;
      (groups[key] = groups[key] || []).push(r);
    });

    var toDelete = [];
    Object.keys(groups).forEach(function (key) {
      var g = groups[key];
      if (g.length !== 2) return;
      var auto = g.filter(function (r) { return r.source === 'SolBoard Auto'; });
      var legacy = g.filter(function (r) { return r.source === 'Legacy Import'; });
      if (auto.length !== 1 || legacy.length !== 1) return;
      if (legacy[0].status !== 'Paid') return;

      var autoAmt = parseFloat(auto[0].paymentAmount);
      var legacyAmt = parseFloat(legacy[0].paymentAmount);
      if (isNaN(autoAmt) || isNaN(legacyAmt) || autoAmt !== legacyAmt) return;

      if (!legacy[0].rowIndex) return; // safety — never delete without a concrete row to target
      toDelete.push({ rowIndex: legacy[0].rowIndex, patient: legacy[0].patient, key: key, amount: legacyAmt });
    });

    if (toDelete.length === 0) {
      Logger.log('No safe duplicates found to delete.');
      return;
    }

    // Delete highest row index first so earlier deletions don't shift
    // the row numbers of ones still pending.
    toDelete.sort(function (a, b) { return b.rowIndex - a.rowIndex; });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PAYMENT_MANUAL);
    if (!sheet) { Logger.log('PaymentTrackerManual sheet not found'); return; }

    var deletedCount = 0;
    toDelete.forEach(function (d) {
      // Re-verify the row's Patient still matches right before deleting —
      // same drift guard savePaymentManualComment uses.
      var rowPatient = String(sheet.getRange(d.rowIndex, 3).getValue() || '').trim();
      if (rowPatient.toLowerCase() !== String(d.patient || '').trim().toLowerCase()) {
        Logger.log('SKIPPED (row moved): ' + d.key + ' — expected "' + d.patient + '" at row ' + d.rowIndex + ', found "' + rowPatient + '"');
        return;
      }
      sheet.deleteRow(d.rowIndex);
      deletedCount++;
      Logger.log('DELETED: ' + d.key + ' — row ' + d.rowIndex + ' ($' + d.amount + ')');
    });

    Logger.log('=== DONE: deleted ' + deletedCount + ' of ' + toDelete.length + ' duplicate Legacy Import rows ===');
  } catch (e) {
    Logger.log('cleanupPaymentTrackerDuplicates error: ' + e.message);
  }
}


/* ════════════════════════════════════════════════════════════════
   USER INFO & ROLE
════════════════════════════════════════════════════════════════ */

function getCurrentUserWithRole() {
  try {
    const email = Session.getActiveUser().getEmail();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const staff = _getStaffRecord(ss, email);
    if (!staff) {
      Logger.log('Unrecognized user: ' + email);
      return JSON.stringify({ email, role: 'unknown', provID: '', displayName: email, initials: '' });
    }
    return JSON.stringify(staff);
  } catch (e) {
    Logger.log('getCurrentUserWithRole error: ' + e.message);
    return JSON.stringify({ email: '', role: 'unknown', provID: '', displayName: '', initials: '' });
  }
}


/* ════════════════════════════════════════════════════════════════
   INTERNAL HELPERS
════════════════════════════════════════════════════════════════ */

function _getStaffRecord(ss, email) {
  const sheet = ss.getSheetByName(TAB_STAFF);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows = sheet.getDataRange().getValues().slice(1);
  const row = rows.find(r => String(r[0]).toLowerCase().trim() === email.toLowerCase().trim());
  if (!row) return null;
  return {
    email: String(row[0] || '').trim(),
    role: String(row[1] || 'unknown').trim(),
    provID: String(row[2] || '').trim(),
    displayName: String(row[3] || '').trim(),
    initials: String(row[4] || '').trim(),
  };
}

function _checkProvAccess(ss, requestedProv) {
  const email = Session.getActiveUser().getEmail();
  const staff = _getStaffRecord(ss, email);
  if (!staff) {
    Logger.log('Access denied — unrecognized user: ' + email);
    return JSON.stringify({ error: 'Access denied: unrecognized user.' });
  }
  if (staff.role === 'provider' && staff.provID !== requestedProv) {
    Logger.log('Access denied — ' + email + ' requested provID ' + requestedProv);
    return JSON.stringify({ error: 'Access denied: you can only view your own appointments.' });
  }
  return null;
}

function _nb(v) {
  if (v === true || v === 'TRUE' || v === 'true') return true;
  if (v === false || v === 'FALSE' || v === 'false') return false;
  return null;
}

function _fmtDate(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return [
      v.getFullYear(),
      String(v.getMonth() + 1).padStart(2, '0'),
      String(v.getDate()).padStart(2, '0'),
    ].join('-');
  }
  return String(v).trim();
}

function _fmtTime(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) {
    return String(v.getHours()).padStart(2, '0') + ':' +
      String(v.getMinutes()).padStart(2, '0');
  }
  if (typeof v === 'number') {
    var totalMins = Math.round(v * 24 * 60);
    var h = Math.floor(totalMins / 60) % 24;
    var m = totalMins % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  return String(v);
}

function _normalizeTimeKey(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date || typeof v === 'number') return _fmtTime(v);
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!m) return s.toLowerCase();
  var h = parseInt(m[1], 10);
  var mi = m[2];
  var p = (m[3] || '').toUpperCase();
  if (p === 'PM' && h !== 12) h += 12;
  if (p === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + mi;
}

function rowToAppt(r) {
  return {
    provID: String(r[0] || ''),   // column A — needed for NPI dropdown in ClaimSubmitModal
    id: String(r[2]),
    date: _fmtDate(r[1]),
    time: _fmtTime(r[3]),
    patient: String(r[4] || ''),
    // Unknown/blank Method cell → blank, NOT a default channel (Solrei brand rule).
    method: String(r[5] || ''),
    alma: { text: String(r[6] || ''), valid: _nb(r[7]) },
    hw: { text: String(r[8] || ''), valid: _nb(r[9]) },
    grow: { text: String(r[10] || ''), valid: _nb(r[11]) },
    directIns: String(r[12] || ''),
    // DirectValid (index 48) stores the explicit valid/issue/null flag for direct-pay.
    // Falls back to presence of directIns text for rows created before this column existed.
    direct: { text: String(r[12] || ''), valid: r[48] !== undefined && r[48] !== '' ? _nb(r[48]) : (r[12] ? true : null) },
    intake: _nb(r[13]),
    ins: _nb(r[14]),
    autopay: _nb(r[15]),
    scr: {
      'PHQ-9': _nb(r[16]),
      'GAD-7': _nb(r[17]),
      'PCL-5': _nb(r[18]),
    },
    ccEhr: String(r[19] || ''),
    notes: String(r[20] || ''),
    unsigned: r[21] ? String(r[21]).split(',').map(s => s.trim()).filter(Boolean) : [],
    cpt: r[22] ? String(r[22]).split(/[|,;]/).map(s => s.trim()).filter(Boolean) : [],
    billing: String(r[23] || 'pending'),
    status: String(r[24] || 'pending'),
    out: r[25] === true || r[25] === 'TRUE',
    paymentType: String(r[26] || ''),
    paymentRate: _sv(r[27]),   // _sv preserves numeric 0 ($0 copay rate)
    paymentAmount: String(r[28] || ''),
    paymentCollected: r[29] === true || r[29] === 'TRUE',
    paymentFailed: r[30] === true || r[30] === 'TRUE',
    comms: (() => {
      try { return r[31] ? JSON.parse(String(r[31])) : []; }
      catch (e) { return []; }
    })(),
    tebraStatus: String(r[34] || ''),
    paymentDate: _fmtDate(r[35]),
    rxMeds: r[36] ? String(r[36]).split('|').map(s => s.trim()).filter(Boolean) : [],
    rxBillerAlert: r[37] === true || r[37] === 'TRUE',
    paymentPlatform: String(r[38] || ''),
    // ── Claim tracking & payout (cols AN-AV, indices 39-47) ──────────────
    claimSubmittedDate: _fmtDate(r[39]),
    claimID: String(r[40] || ''),
    claimStatus: String(r[41] || ''),
    claimStatusNotes: String(r[42] || ''),
    claimPaidDate: _fmtDate(r[43]),
    claimPaidAmount: String(r[44] || ''),
    claimCheckID: String(r[45] || ''),
    claimDepositBank: String(r[46] || ''),
    claimDepositDate: _fmtDate(r[47]),
    // ── Claims Ledger supplemental (indices 49-52) ────────────────────────
    claimERA: String(r[49] || ''),
    claimBundled: r[50] === true || r[50] === 'TRUE',
    claimBundledAmount: String(r[51] || ''),
    claimDepositAmount: String(r[52] || ''),
    // ── Patient context — denormalized from Patient DB (indices 53-54) ──────
    insuranceCarrier: String(r[53] || ''),
    patientState: String(r[54] || ''),
    // ── Clinic Note Status (index 55) ────────────────────────────────────────
    noteStatus: String(r[55] || ''),
    // ── Screener scores + assistant notes (indices 56-58) ────────────────────
    scrData: (() => {
      try { return r[56] ? JSON.parse(String(r[56])) : { 'PHQ-9': { score: '' }, 'GAD-7': { score: '' }, 'PCL-5': { score: '' } }; }
      catch (e) { return { 'PHQ-9': { score: '' }, 'GAD-7': { score: '' }, 'PCL-5': { score: '' } }; }
    })(),
    scrNote: String(r[57] || ''),
    checklistNote: String(r[58] || ''),
    // Standalone column (99 / CU, outside APPT_COLS' own width — see the
    // comment above INTAKE_UPDATES_COL) — safe to read directly off `r`
    // here since every caller of rowToAppt() sources its rows via
    // sheet.getDataRange().getValues(), the full sheet width, not a
    // range scoped to APPT_COLS.length. Same JSON-array-on-one-column
    // pattern as `comms` above.
    intakeUpdates: (() => {
      try {
        var cell = r[INTAKE_UPDATES_COL - 1];
        return cell ? JSON.parse(String(cell)) : [];
      } catch (e) { return []; }
    })(),
  };
}

function apptToRow(appt, prov, date) {
  return [
    prov,
    date,
    appt.id,
    appt.time,
    appt.patient,
    appt.method,
    appt.alma?.text || '',
    appt.alma?.valid ?? '',
    appt.hw?.text || '',
    appt.hw?.valid ?? '',
    appt.grow?.text || '',
    appt.grow?.valid ?? '',
    appt.directIns || '',
    appt.intake ?? '',
    appt.ins ?? '',
    appt.autopay ?? '',
    appt.scr?.['PHQ-9'] ?? '',
    appt.scr?.['GAD-7'] ?? '',
    appt.scr?.['PCL-5'] ?? '',
    appt.ccEhr || '',
    appt.notes || '',
    (appt.unsigned || []).join(','),
    (appt.cpt || []).join('|'),
    appt.billing || 'pending',
    appt.status || 'pending',
    // Signed (col Z): TRUE if already marked signed; otherwise blank until
    // this appointment's own date+time passes, then FALSE — never downgrades
    // an existing TRUE. See _expectedSignedValue (2026-08-04).
    appt.out ? true : _expectedSignedValue(appt.tebraStatus || '', date, appt.time),
    appt.paymentType || '',
    _sv(appt.paymentRate),    // _sv preserves '0' / numeric 0 ($0 copay)
    appt.paymentAmount || '',
    appt.paymentCollected ? true : false,
    appt.paymentFailed ? true : false,
    JSON.stringify(appt.comms || []),
    new Date(),
    Session.getActiveUser().getEmail(),
    appt.tebraStatus || '',
    appt.paymentDate || '',
    (appt.rxMeds || []).join('|'),
    appt.rxBillerAlert ? true : false,
    appt.paymentPlatform || '',
    // ── Claim tracking & payout (indices 39-47) ──────────────────────────
    appt.claimSubmittedDate || '',
    appt.claimID || '',
    appt.claimStatus || '',
    appt.claimStatusNotes || '',
    appt.claimPaidDate || '',
    appt.claimPaidAmount || '',
    appt.claimCheckID || '',
    appt.claimDepositBank || '',
    appt.claimDepositDate || '',
    // Index 48 — DirectValid: explicit valid/issue/null flag for direct-pay appointments.
    // Mirrors AlmaValid (idx 7), HWValid (idx 9), GrowValid (idx 11).
    appt.direct?.valid ?? '',
    // Indices 49-52 — Claims Ledger supplemental fields
    appt.claimERA || '',
    appt.claimBundled ? true : false,
    appt.claimBundledAmount || '',
    appt.claimDepositAmount || '',
    // Indices 53-54 — Patient context (denormalized from Patient DB)
    appt.insuranceCarrier || '',
    appt.patientState || '',
    // Index 55 — Clinic Note Status
    appt.noteStatus || '',
    // Indices 56-58 — Screener scores + assistant notes (added for PatientInfoModal)
    appt.scrData ? JSON.stringify(appt.scrData) : '',   // index 56 — ScrData
    appt.scrNote || '',                           // index 57 — ScrNote
    appt.checklistNote || '',                           // index 58 — ChecklistNote
  ];
}

/* ── _isValidUSState: returns true for valid 2-letter US state/territory codes ─
   Used to guard PatientState reads so PrimarySubscriber or other non-state
   data never gets written into the PatientState column.
────────────────────────────────────────────────────────────────────────────── */
var VALID_US_STATES = {
  AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, FL: 1, GA: 1,
  HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1, MD: 1,
  MA: 1, MI: 1, MN: 1, MS: 1, MO: 1, MT: 1, NE: 1, NV: 1, NH: 1, NJ: 1,
  NM: 1, NY: 1, NC: 1, ND: 1, OH: 1, OK: 1, OR: 1, PA: 1, RI: 1, SC: 1,
  SD: 1, TN: 1, TX: 1, UT: 1, VT: 1, VA: 1, WA: 1, WV: 1, WI: 1, WY: 1,
  DC: 1, PR: 1, VI: 1, GU: 1, AS: 1, MP: 1
};
function _isValidUSState(s) {
  return !!s && !!VALID_US_STATES[String(s).trim().toUpperCase()];
}

/* ── _lookupPatient: fetch insurance + state from the Patient DB ─────────────
   Matches on normalized full name (first + last, case-insensitive, no extra
   spaces). Returns { insurance, patientState } — empty strings if not found.
   Reads the Patients tab header row dynamically to find PatientState column,
   so it is robust to schema changes without a sheet re-initialization.
   Called by saveAppointment so InsuranceCarrier and PatientState are always
   stamped on the appointment row without any manual input.
────────────────────────────────────────────────────────────────────────────── */
function _lookupPatient(ss, patientName) {
  try {
    if (!patientName) return { insurance: '', patientState: '' };
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) return { insurance: '', patientState: '' };
    var rows = sheet.getDataRange().getValues();
    // Resolve column indices from actual header row so sheet layout ≠ PATIENT_COLS is safe
    var hdr = rows[0].map(function (h) { return String(h || '').trim(); });
    var COL_INSURANCE = hdr.indexOf('InsuranceCarrier'); // fallback: PATIENT_COLS index 3
    var COL_STATE = hdr.indexOf('PatientState'); // fallback: PATIENT_COLS index 12
    if (COL_INSURANCE < 0) COL_INSURANCE = 3;
    if (COL_STATE < 0) COL_STATE = 12;
    var norm = _normName(patientName);
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var fullName = _normName(String(r[0] || '') + ' ' + String(r[1] || ''));
      if (fullName === norm) {
        var rawState = String(r[COL_STATE] || '').trim().toUpperCase();
        return {
          insurance: String(r[COL_INSURANCE] || ''),
          patientState: _isValidUSState(rawState) ? rawState : '',
        };
      }
    }
    return { insurance: '', patientState: '' };
  } catch (e) {
    Logger.log('_lookupPatient error (non-fatal): ' + e.message);
    return { insurance: '', patientState: '' };
  }
}

function _audit(ss, action, details) {
  try {
    const sheet = ss.getSheetByName(TAB_AUDIT);
    if (!sheet) return;
    sheet.appendRow([
      new Date(),
      Session.getActiveUser().getEmail(),
      action,
      details,
    ]);
  } catch (e) {
    Logger.log('Audit write failed (non-fatal): ' + e.message);
  }
}


/* ════════════════════════════════════════════════════════════════
   TEBRA EXCEL IMPORT
════════════════════════════════════════════════════════════════ */

const TEBRA_IMPORT_SHEET_ID = '';

function runTebraImport() {
  if (!TEBRA_IMPORT_SHEET_ID) {
    Logger.log('❌  Set TEBRA_IMPORT_SHEET_ID at the top of the Tebra Import section first.');
    return;
  }
  const result = JSON.parse(importTebraAppointments(TEBRA_IMPORT_SHEET_ID, false));
  Logger.log('✅  Import complete: ' + JSON.stringify(result, null, 2));
}

function runTebraImportDryRun() {
  if (!TEBRA_IMPORT_SHEET_ID) {
    Logger.log('❌  Set TEBRA_IMPORT_SHEET_ID first.');
    return;
  }
  const result = JSON.parse(importTebraAppointments(TEBRA_IMPORT_SHEET_ID, true));
  Logger.log('DRY RUN — would import ' + result.parsed + ' appointments:');
  (result.appointments || []).forEach((a, i) => {
    Logger.log(`  ${i + 1}. [${a.provID}] ${a.date}  ${a.time}  —  ${a.patient}`);
  });
  if (result.errors && result.errors.length) {
    Logger.log('Warnings: ' + JSON.stringify(result.errors));
  }
}

function importTebraAppointments(sheetId, dryRun) {
  try {
    const tebraSS = SpreadsheetApp.openById(sheetId);
    const tebraSheet =
      tebraSS.getSheets().find(s => s.getName() === 'rptAppointmentsDetail') ||
      tebraSS.getSheets()[0];

    if (!tebraSheet) {
      return JSON.stringify({ error: 'Could not find rptAppointmentsDetail sheet' });
    }

    const lastRow = tebraSheet.getLastRow();
    const lastCol = Math.max(tebraSheet.getLastColumn(), 16);
    if (lastRow < 2) return JSON.stringify({ imported: 0, skipped: 0, total: 0, errors: [] });

    const allRows = tebraSheet.getRange(1, 1, lastRow, lastCol).getValues();

    const PROVIDER_MAP = {
      'jodene': 'jodene',
      'jensen': 'jodene',
      'katie': 'katie',
      'robins': 'katie',
      'lori': 'lori',
    };

    function resolveProvID(headerText) {
      if (!headerText) return null;
      const lower = String(headerText).toLowerCase();
      for (const keyword in PROVIDER_MAP) {
        if (lower.indexOf(keyword) !== -1) return PROVIDER_MAP[keyword];
      }
      return null;
    }

    const appointments = [];
    const errors = [];
    let currentProvID = null;
    let currentDate = null;

    for (var i = 0; i < allRows.length; i++) {
      var row = allRows[i];
      var colA = row[0];
      var colB = row[1];
      var colD = row[3];
      var colP = row[15];

      if (colA && !colB && typeof colA === 'string' && colA.trim().length > 3) {
        var pid = resolveProvID(colA);
        if (pid) {
          currentProvID = pid;
          currentDate = null;
        }
        continue;
      }

      if (colB instanceof Date && !isNaN(colB.getTime()) && !colD) {
        currentDate = _fmtDate(colB);
        continue;
      }

      if (colD && typeof colD === 'string' && colD.indexOf(' - ') !== -1 && colP) {
        if (!currentProvID) {
          errors.push('Row ' + (i + 1) + ': no provider context for "' + colP + '"');
          continue;
        }
        if (!currentDate) {
          errors.push('Row ' + (i + 1) + ': no date context for "' + colP + '"');
          continue;
        }

        // Strip trailing Tebra patient-ID suffix "(123)", then strip any middle
        // name so only First + Last are stored — consistent with the API path.
        var patientName = _titleCase(
          _stripMiddleName(
            String(colP).trim().replace(/\s*\(\d+\)\s*$/, '').trim()
          )
        );

        var apptTime = colD.split(' - ')[0].trim();

        appointments.push({
          provID: currentProvID,
          date: currentDate,
          time: apptTime,
          patient: patientName,
        });
      }
    }

    if (dryRun) {
      Logger.log('DRY RUN — ' + appointments.length + ' appointments parsed.');
      return JSON.stringify({
        dryRun: true,
        parsed: appointments.length,
        appointments: appointments,
        errors: errors,
      });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const apptSheet = ss.getSheetByName(TAB_APPT);

    if (!apptSheet) {
      return JSON.stringify({ error: 'Appointments sheet not found — run initializeSheets() first' });
    }

    var patientLookup = {};
    const PLATFORM_TO_METHOD = { 'alma': 'alma', 'headway': 'hw', 'grow': 'grow', 'direct': 'direct' };
    var patSheet = ss.getSheetByName(TAB_PATIENT);
    if (patSheet && patSheet.getLastRow() > 1) {
      patSheet.getRange(2, 1, patSheet.getLastRow() - 1, 6).getValues().forEach(function (r) {
        var first = String(r[0] || '').trim();
        var last = String(r[1] || '').trim();
        if (!first && !last) return;
        var fullName = (first + ' ' + last).trim().toLowerCase();
        var platform = String(r[2] || '').trim().toLowerCase();
        patientLookup[fullName] = {
          // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
          method: PLATFORM_TO_METHOD[platform] || '',
          insurance: String(r[3] || '').trim(),
          patientPortion: String(r[4] || '').trim(),
          rate: _sv(r[5]).trim(),   // _sv preserves numeric 0 ($0 copay)
        };
      });
    }
    Logger.log('Patient lookup built: ' + Object.keys(patientLookup).length + ' patients');

    var existingKeys = new Set();
    if (apptSheet.getLastRow() > 1) {
      var existing = apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, 4).getValues();
      existing.forEach(function (r) {
        existingKeys.add(r[0] + '||' + _fmtDate(r[1]) + '||' + _normalizeTimeKey(r[3]));
      });
    }

    var imported = 0;
    var skipped = 0;

    appointments.forEach(function (appt) {
      var key = appt.provID + '||' + appt.date + '||' + _normalizeTimeKey(appt.time);
      if (existingKeys.has(key)) {
        skipped++;
        return;
      }

      var ptInfo = patientLookup[appt.patient.toLowerCase()] || {};
      // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
      var method = ptInfo.method || '';
      var isDirect = method === 'direct';

      var apptId = 'TEBRA-' + new Date().getTime() + '-' +
        Math.random().toString(36).substr(2, 4).toUpperCase();

      var rowData = apptToRow({
        id: apptId,
        time: appt.time,
        patient: appt.patient,
        method: method,
        alma: { text: '', valid: null },
        hw: { text: '', valid: null },
        grow: { text: '', valid: null },
        directIns: ptInfo.insurance || '',
        intake: null,
        ins: null,
        autopay: null,
        scr: { 'PHQ-9': null, 'GAD-7': null, 'PCL-5': null },
        ccEhr: '',
        notes: 'Imported from Tebra',
        unsigned: [],
        cpt: [],
        billing: 'pending',
        status: 'pending',
        out: false,
        paymentType: isDirect ? ptInfo.patientPortion : '',
        paymentRate: isDirect ? ptInfo.rate : '',
        paymentAmount: '',
        paymentCollected: false,
        paymentFailed: false,
        comms: [],
      }, appt.provID, appt.date);

      var newRow = apptSheet.getLastRow() + 1;
      apptSheet.getRange(newRow, 4).setNumberFormat('@');
      apptSheet.getRange(newRow, 1, 1, rowData.length).setValues([rowData]);
      existingKeys.add(key);
      imported++;
    });

    SpreadsheetApp.flush();
    _audit(ss, 'TEBRA_IMPORT',
      'Imported ' + imported + ', skipped ' + skipped + ' from sheet ' + sheetId);

    Logger.log('Tebra import: ' + imported + ' imported, ' + skipped + ' skipped, ' +
      errors.length + ' warnings.');

    return JSON.stringify({
      imported: imported,
      skipped: skipped,
      total: appointments.length,
      errors: errors,
    });

  } catch (e) {
    Logger.log('importTebraAppointments error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   TEBRA LIVE API IMPORT
════════════════════════════════════════════════════════════════ */

/* ── TEBRA API KILL SWITCH ───────────────────────────────────────────────────
   Controls whether any outbound Tebra/Kareo API call is allowed.
 
   TWO ways to toggle:
     1. UI Toggle  — use the "Tebra API" switch in the Billing Window header.
        State is stored in Script Properties (survives deploys and restarts).
     2. Code default — TEBRA_API_DEFAULT below is the fallback when no Script
        Property has been set yet (e.g. fresh deploy).
 
   Script Property key: 'TEBRA_API_ENABLED'  (values: 'true' | 'false')
────────────────────────────────────────────────────────────────────────────── */
var TEBRA_API_DEFAULT = true;   // ← code-level fallback; UI toggle takes precedence

/* Returns true if Tebra API calls are currently allowed.
   Reads from Script Properties so the UI toggle persists across executions. */
function _isTebraApiEnabled() {
  var prop = PropertiesService.getScriptProperties().getProperty('TEBRA_API_ENABLED');
  if (prop === null || prop === undefined) return TEBRA_API_DEFAULT;
  return prop !== 'false';
}

/* Called by the CRB UI on load to show the current toggle state. */
function getTebraApiStatus() {
  return JSON.stringify({ enabled: _isTebraApiEnabled() });
}

/* Called by the CRB UI toggle switch to flip the API on or off. */
function setTebraApiEnabled(enabled) {
  var val = !!enabled;
  PropertiesService.getScriptProperties().setProperty('TEBRA_API_ENABLED', val ? 'true' : 'false');
  Logger.log((val ? '✅' : '🔴') + ' Tebra API ' + (val ? 'ENABLED' : 'DISABLED') + ' via CRB UI toggle.');
  _audit(SpreadsheetApp.getActiveSpreadsheet(),
    val ? 'TEBRA_API_ENABLED' : 'TEBRA_API_DISABLED',
    'Tebra API connection ' + (val ? 'enabled' : 'disabled') + ' via Billing Window toggle.');
  return JSON.stringify({ enabled: val });
}

// Keep the old var name around as an alias so any leftover references don't break
var TEBRA_API_ENABLED = TEBRA_API_DEFAULT;

const TEBRA_ENDPOINT =
  'https://webservice.kareo.com/services/soap/2.1/KareoServices.svc';

// Provider name → CRB provider key mapping.
// Keys are lowercase substrings matched against ResourceName1 returned by Tebra.
// Add last-name entries so e.g. "Dr. Jensen" still maps to 'jodene'.
const TEBRA_PROVIDER_MAP = {
  'jodene': 'jodene',
  'jensen': 'jodene',   // Jodene's last name
  'katie': 'katie',
  'robins': 'katie',    // Katie's last name
  'lori': 'lori',
};

/**
 * Returns the CRB provider key (e.g. 'jodene') for a given Tebra ResourceName1
 * string, or null if no match is found.
 */
function _matchTebraProvider(resourceName) {
  if (!resourceName) return null;
  var lower = resourceName.toLowerCase();
  for (var key in TEBRA_PROVIDER_MAP) {
    if (lower.indexOf(key) !== -1) return TEBRA_PROVIDER_MAP[key];
  }
  return null;
}

// ── Tebra Credential Setup ────────────────────────────────────────────────────
// Credentials are stored in Script Properties (never hardcoded here).
// To set or update credentials, go to:
//   Apps Script editor → Project Settings (gear icon) → Script Properties
// Add or edit these three keys:
//   TEBRA_CUSTOMER_KEY   → your Tebra customer key (e.g. b74sq26zx39e)
//   TEBRA_PASSWORD       → your Tebra API password
//   TEBRA_USER           → your Tebra login email
//
// You can verify credentials are loaded by running checkTebraCreds() below.
function checkTebraCreds() {
  var c = _getTebraCreds();
  if (!c.customerKey || !c.password || !c.user) {
    Logger.log('❌  One or more Tebra credentials are missing from Script Properties.');
    Logger.log('    TEBRA_CUSTOMER_KEY : ' + (c.customerKey ? '✅ set' : '❌ MISSING'));
    Logger.log('    TEBRA_PASSWORD     : ' + (c.password ? '✅ set' : '❌ MISSING'));
    Logger.log('    TEBRA_USER         : ' + (c.user ? '✅ set' : '❌ MISSING'));
    Logger.log('    Go to: Project Settings → Script Properties to add them.');
  } else {
    Logger.log('✅  Tebra credentials are set.');
    Logger.log('    TEBRA_CUSTOMER_KEY : ' + c.customerKey);
    Logger.log('    TEBRA_USER         : ' + c.user);
    Logger.log('    TEBRA_PASSWORD     : [hidden]');
  }
}

function _getTebraCreds() {
  var p = PropertiesService.getScriptProperties();
  return {
    customerKey: p.getProperty('TEBRA_CUSTOMER_KEY') || '',
    password: p.getProperty('TEBRA_PASSWORD') || '',
    user: p.getProperty('TEBRA_USER') || '',
  };
}

function _xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _tebraHeader(c) {
  return '<ns:RequestHeader>' +
    '<ns:CustomerKey>' + _xmlEscape(c.customerKey) + '</ns:CustomerKey>' +
    '<ns:Password>' + _xmlEscape(c.password) + '</ns:Password>' +
    '<ns:User>' + _xmlEscape(c.user) + '</ns:User>' +
    '</ns:RequestHeader>';
}

function _tebraPost(operationName, bodyXml) {
  if (!_isTebraApiEnabled()) {
    Logger.log('🔴 Tebra API disabled — ' + operationName + ' blocked. Use the Billing Window toggle to re-enable.');
    throw new Error('Tebra API is currently disabled. Use the API toggle in the Billing Window to turn it back on.');
  }

  var soapAction =
    'http://www.kareo.com/api/schemas/KareoServices/' + operationName;

  var envelope =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"' +
    '               xmlns:ns="http://www.kareo.com/api/schemas/">' +
    '<soap:Body>' + bodyXml + '</soap:Body>' +
    '</soap:Envelope>';

  var resp = UrlFetchApp.fetch(TEBRA_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': soapAction,
    },
    payload: envelope,
    muteHttpExceptions: true,
  });

  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' from Tebra: ' + text.substr(0, 400));
  }
  return text;
}

function _tebraDateFmt(d) {
  return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
}

function _parseYMD(s) {
  var p = s.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
}

function _parseTebraStartDate(s) {
  if (!s) return { date: '', time: '' };
  s = s.trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):\d{2}\s*(AM|PM)$/i);
  if (!m) return { date: '', time: s };

  var mo = parseInt(m[1], 10) - 1;
  var dy = parseInt(m[2], 10);
  var yr = parseInt(m[3], 10);
  var hr = parseInt(m[4], 10);
  var min = parseInt(m[5], 10);
  var period = m[6].toUpperCase();

  if (period === 'PM' && hr !== 12) hr += 12;
  if (period === 'AM' && hr === 12) hr = 0;

  var dt = new Date(yr, mo, dy, hr + 3, min, 0);

  var date =
    dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0');

  var time = String(dt.getHours()).padStart(2, '0') + ':' +
    String(dt.getMinutes()).padStart(2, '0');

  return { date: date, time: time };
}

function _titleCase(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\b\w/g, function (c) {
    return c.toUpperCase();
  });
}

/**
 * Strips middle names and middle initials from a full name string.
 * Tebra's PatientFullName sometimes includes a middle name or initial
 * (e.g. "Jane Marie Smith" or "Jane M Smith").  The CRB stores only
 * First + Last to match the Patient DB and avoid duplicate appointment rows.
 *
 * Rules:
 *   "Jane Smith"        → "Jane Smith"        (2 parts — no change)
 *   "Jane M Smith"      → "Jane Smith"        (3 parts — drop middle)
 *   "Jane Marie Smith"  → "Jane Smith"        (3 parts — drop middle)
 *   "Mary Jo Smith"     → "Mary Jo Smith"     (treat 2-word first names as-is — ambiguous;
 *                                               we only strip when there are 3+ parts AND the
 *                                               middle token is a single letter or recognised
 *                                               as a middle name via the 3-token heuristic)
 *
 * For safety: if there are exactly 3 tokens AND the middle one is ≤3 chars
 * (an initial like "M" or a short middle name like "Jo"), we drop it.
 * Otherwise we keep all parts to avoid mangling legitimate compound first names.
 */
function _stripMiddleName(fullName) {
  if (!fullName) return '';
  var parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(' ');
  // For 3+ parts: drop everything between first and last token.
  // This handles both single initials ("M") and full middle names ("Marie").
  return parts[0] + ' ' + parts[parts.length - 1];
}

/**
 * Returns true when two patient name strings refer to the same person,
 * ignoring middle names/initials.
 * e.g. "Jane Smith" vs "Jane M Smith" → true
 *      "Jane Smith" vs "John Smith"   → false
 */
function _samePatient(nameA, nameB) {
  function fl(n) {
    var p = _stripMiddleName(String(n || '').toLowerCase().replace(/\s+/g, ' ').trim());
    return p;
  }
  return fl(nameA) === fl(nameB);
}

function _findXmlElements(el, localName, results) {
  if (el.getName() === localName) { results.push(el); return; }
  el.getChildren().forEach(function (child) {
    _findXmlElements(child, localName, results);
  });
}

// Recursive single-value lookup — preferred over _getXmlChildText for all Tebra fields.
function _findFirstXml(el, localName) {
  var r = [];
  _findXmlElements(el, localName, r);
  return r.length ? r[0].getText().trim() : '';
}

function _getXmlChildText(el, localName) {
  var children = el.getChildren();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName() === localName) return children[i].getText();
  }
  return '';
}


function testTebraConnection() {
  var c = _getTebraCreds();
  if (!c.customerKey) {
    Logger.log('❌  Credentials not set — run setTebraCreds() first.');
    return;
  }
  var bodyXml =
    '<ns:GetProviders><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:ProviderID>true</ns:ProviderID>' +
    '<ns:ProviderFirstName>true</ns:ProviderFirstName>' +
    '<ns:ProviderLastName>true</ns:ProviderLastName>' +
    '<ns:PracticeID>true</ns:PracticeID>' +
    '</ns:Fields>' +
    '</ns:request></ns:GetProviders>';

  try {
    var text = _tebraPost('GetProviders', bodyXml);
    Logger.log('✅  Connected. Full response:');
    Logger.log(text.substr(0, 3000));
  } catch (e) {
    Logger.log('❌  ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: run this from Apps Script to see exactly what
// ConfirmationStatus values Tebra is returning for today's appointments.
// Check the Apps Script Logs (View → Logs) after running.
// ─────────────────────────────────────────────────────────────────
function testTebraStatusFetch() {
  var c = _getTebraCreds();
  if (!c.customerKey) {
    Logger.log('❌  Run setTebraCreds() first.');
    return;
  }
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  Logger.log('── testTebraStatusFetch for ' + today + ' ──────────────────');
  try {
    var appts = _fetchTebraAppointments(c, today, today);
    Logger.log('Total returned (before filter): fetched ' + appts.length + ' valid appointments');
    appts.forEach(function (a, i) {
      Logger.log(
        '  [' + i + '] Patient: "' + a.patient + '"' +
        '  ConfirmationStatus: "' + a.tebraStatus + '"' +
        '  Provider: ' + (a.provID || '?') +
        '  Date: ' + a.date + '  Time: ' + a.time +
        (a._statusOnly ? '  [STATUS-ONLY — will not create new row]' : '')
      );
    });
    if (appts.length === 0) {
      Logger.log('  ⚠️  No appointments returned. Check date range or TEBRA_PROVIDER_MAP.');
    }
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: Run this to see the raw ResourceName1 / ResourceID1
// values Tebra actually returns — use this to verify TEBRA_PROVIDER_MAP
// has the right name substrings for your providers.
// Check View → Logs after running.
// ─────────────────────────────────────────────────────────────────
function testTebraProviders() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var startTebra = _tebraDateFmt(_parseYMD(today));

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
    '<ns:ID>true</ns:ID>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:ResourceID1>true</ns:ResourceID1>' +
    '<ns:ResourceName1>true</ns:ResourceName1>' +
    '<ns:StartDate>true</ns:StartDate>' +
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:StartDate>' + startTebra + '</ns:StartDate>' +
    '<ns:EndDate>' + startTebra + '</ns:EndDate>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  try {
    var text = _tebraPost('GetAppointments', bodyXml);
    var doc = XmlService.parse(text);
    var root = doc.getRootElement();

    var apptEls = [];
    _findXmlElements(root, 'AppointmentData', apptEls);
    Logger.log('=== testTebraProviders: ' + apptEls.length + ' patient appointments for ' + today + ' ===');

    // Dump the raw XML of the first element so we can see the exact structure
    if (apptEls.length) {
      try {
        Logger.log('── First AppointmentData raw XML ──');
        Logger.log(XmlService.getRawFormat().format(apptEls[0]).substr(0, 2000));
      } catch (e) { /* non-critical */ }
    }

    apptEls.forEach(function (el, i) {
      var name = _findFirstXml(el, 'PatientFullName');
      var res1 = _findFirstXml(el, 'ResourceName1');
      var resId1 = _findFirstXml(el, 'ResourceID1');
      var status = _findFirstXml(el, 'ConfirmationStatus');
      var start = _findFirstXml(el, 'StartDate');
      var matched = _matchTebraProvider(res1);
      Logger.log(
        '[' + i + '] Patient: "' + name + '"' +
        ' | ResourceName1: "' + res1 + '" (ID: ' + resId1 + ')' +
        ' | Status: "' + status + '"' +
        ' | Start: "' + start + '"' +
        ' | CRB match → ' + (matched || '⚠️ NO MATCH — add to TEBRA_PROVIDER_MAP')
      );
    });

    if (!apptEls.length) {
      Logger.log('⚠️  No appointments returned for today. Try a busier date.');
      Logger.log('   Full response: ' + text.substring(0, 3000));
    }
  } catch (e) {
    Logger.log('❌  ' + e.message);
  }
}


// ─────────────────────────────────────────────────────────────────
// MAINTENANCE: call once after adding columns to APPT_COLS to
// update the header row in the Appointments sheet.
// Safe to run on a live sheet — only updates row 1.
// ─────────────────────────────────────────────────────────────────
function updateSheetHeaders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet) {
    Logger.log('❌  Appointments sheet not found.');
    return;
  }
  // Extend columns if needed
  var needed = APPT_COLS.length;
  if (sheet.getMaxColumns() < needed) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
  }
  // Write all header names
  sheet.getRange(1, 1, 1, needed).setValues([APPT_COLS]);
  styleHeaderRow(sheet, needed, '#2B2716', '#F2EDDB');
  SpreadsheetApp.flush();
  Logger.log('✅  Headers updated — ' + needed + ' columns: ' + APPT_COLS.join(', '));
  return 'Headers updated: ' + needed + ' columns';
}

function testTebraGetAppointments(dateStr, provId) {
  var c = _getTebraCreds();
  if (!c.customerKey) {
    Logger.log('❌  Run setTebraCreds() first.');
    return;
  }
  provId = provId || 1;
  dateStr = dateStr ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var tDate = _tebraDateFmt(_parseYMD(dateStr));
  Logger.log('Fetching appointments for ' + dateStr +
    ' (Tebra date: ' + tDate + '), provider ID ' + provId);

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
    '<ns:ID>true</ns:ID>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:ResourceID1>true</ns:ResourceID1>' +
    '<ns:ResourceName1>true</ns:ResourceName1>' +
    '<ns:StartDate>true</ns:StartDate>' +
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:StartDate>' + tDate + '</ns:StartDate>' +
    '<ns:EndDate>' + tDate + '</ns:EndDate>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  try {
    var text = _tebraPost('GetAppointments', bodyXml);
    Logger.log('=== RAW RESPONSE ===');
    Logger.log(text.substr(0, 5000));
    if (text.length > 5000) Logger.log('... (truncated, total ' + text.length + ' chars)');
  } catch (e) {
    Logger.log('❌  ' + e.message);
  }
}


/* ── _extractStateFromLocationName ───────────────────────────────────────────
   Parses a Tebra service location Name into a 2-letter US state abbreviation.
   Solrei's naming convention: "StateName - Solrei Behavioral Health, Inc."
   e.g. "Alaska - Solrei Behavioral Health, Inc." → "AK"
        "D.C. - Solrei Behavioral Health, Inc."   → "DC"
──────────────────────────────────────────────────────────────────────────── */
function _extractStateFromLocationName(name) {
  if (!name) return '';
  var STATE_NAME_MAP = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'd.c.': 'DC', 'dc': 'DC', 'district of columbia': 'DC', 'washington dc': 'DC', 'washington d.c.': 'DC',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY'
  };
  // Strip everything from " - Solrei" onward (handles any variation of the suffix)
  var statePart = name.replace(/\s*-\s*Solrei\b.*/i, '').trim();
  return STATE_NAME_MAP[statePart.toLowerCase()] || '';
}

/* ── _fetchServiceLocationMap ─────────────────────────────────────────────────
   Calls GetServiceLocations once per sync to build a lookup of:
     locationName  → 2-letter state abbrev
     locationID    → 2-letter state abbrev
   Uses ClientVersion 2.1 (required by GetServiceLocations).
   Non-fatal: returns empty maps if the call fails so the rest of the sync continues.
──────────────────────────────────────────────────────────────────────────── */
function _fetchServiceLocationMap(c) {
  var nameToState = {};
  var idToState = {};
  if (!_isTebraApiEnabled()) {
    Logger.log('🔴 Tebra API disabled — GetServiceLocations blocked.');
    return { nameToState: nameToState, idToState: idToState };
  }
  try {
    // GetServiceLocations requires TWO namespace prefixes — this is how Tebra designed it
    // and differs from GetAppointments.  Must bypass _tebraPost and build the full envelope:
    //   sch:  = http://www.kareo.com/api/schemas/  (WITH trailing slash) — outer elements
    //   sch1: = http://www.kareo.com/api/schemas   (NO  trailing slash)  — Fields + Filter
    var envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soapenv:Envelope' +
      ' xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"' +
      ' xmlns:sch="http://www.kareo.com/api/schemas/"' +
      ' xmlns:sch1="http://www.kareo.com/api/schemas">' +
      '<soapenv:Body>' +
      '<sch:GetServiceLocations>' +
      '<sch:request>' +
      '<sch:RequestHeader>' +
      '<sch:ClientVersion>2.1</sch:ClientVersion>' +
      '<sch:CustomerKey>' + _xmlEscape(c.customerKey) + '</sch:CustomerKey>' +
      '<sch:Password>' + _xmlEscape(c.password) + '</sch:Password>' +
      '<sch:User>' + _xmlEscape(c.user) + '</sch:User>' +
      '</sch:RequestHeader>' +
      '<sch1:Fields>' +
      '<sch1:ID>true</sch1:ID>' +
      '<sch1:Name>true</sch1:Name>' +
      '</sch1:Fields>' +
      '<sch1:Filter>' +
      '<sch1:PracticeName>Solrei Behavioral Health, Inc.</sch1:PracticeName>' +
      '</sch1:Filter>' +
      '</sch:request>' +
      '</sch:GetServiceLocations>' +
      '</soapenv:Body>' +
      '</soapenv:Envelope>';

    var resp = UrlFetchApp.fetch(TEBRA_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': 'http://www.kareo.com/api/schemas/KareoServices/GetServiceLocations',
      },
      payload: envelope,
      muteHttpExceptions: true,
    });
    var text = resp.getContentText();
    Logger.log('🔍 GetServiceLocations raw (first 800): ' + text.substr(0, 800));

    var doc = XmlService.parse(text);
    var root = doc.getRootElement();

    // Check auth
    var secEls = [];
    _findXmlElements(root, 'SecurityResponse', secEls);
    if (secEls.length) {
      Logger.log('  GetServiceLocations auth: Authenticated=' + _findFirstXml(secEls[0], 'Authenticated') +
        ' SecurityResult=' + _findFirstXml(secEls[0], 'SecurityResult'));
    }

    var els = [];
    _findXmlElements(root, 'ServiceLocationData', els);
    Logger.log('  ServiceLocationData elements found: ' + els.length);
    els.forEach(function (el) {
      var name = _findFirstXml(el, 'Name');
      var id = _findFirstXml(el, 'ID');
      var abbr = _extractStateFromLocationName(name);
      Logger.log('  Location: "' + name + '" → abbr="' + abbr + '"');
      if (abbr) {
        if (name) nameToState[name] = abbr;
        if (id) idToState[id] = abbr;
      }
    });
    Logger.log('✅  Service location map: ' + Object.keys(nameToState).length +
      ' locations → ' + JSON.stringify(nameToState));
  } catch (e) {
    Logger.log('⚠️  _fetchServiceLocationMap failed (non-fatal): ' + e.message);
  }
  return { nameToState: nameToState, idToState: idToState };
}


// quiet (optional, default false) — suppresses the four raw-patient-name
// narration lines below (placeholder-skip, invalid-skip, incomplete-skip,
// Status-only) for callers that redact patient identity in their own
// output (e.g. reconcileStaleTebraStatuses). Additive and
// backward-compatible: every existing call site omits this argument, so
// it's always undefined → falsy there, and behavior is unchanged. The
// PII-free "Tebra returned N total appointment elements" line always
// logs regardless, since it carries no patient data and is needed for
// timing visibility.
function _fetchTebraAppointments(c, startDateStr, endDateStr, quiet) {
  var startTebra = _tebraDateFmt(_parseYMD(startDateStr));
  var endTebra = _tebraDateFmt(_parseYMD(endDateStr));

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
    '<ns:ID>true</ns:ID>' +
    '<ns:PatientCaseID>true</ns:PatientCaseID>' +
    '<ns:PatientCaseName>true</ns:PatientCaseName>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:PatientID>true</ns:PatientID>' +   // NEW (2026-08-17) — confirmed valid/populated via testTebraAppointmentsWithPatientID()
    '<ns:ResourceID1>true</ns:ResourceID1>' +
    '<ns:ResourceName1>true</ns:ResourceName1>' +
    '<ns:StartDate>true</ns:StartDate>' +
    // NOTE: ServiceLocationName and ServiceLocationID are NOT valid Fields for
    // GetAppointments — requesting them causes Tebra to silently return 0 results.
    // PatientState is instead resolved via a separate GetServiceLocations call.
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:StartDate>' + startTebra + '</ns:StartDate>' +
    '<ns:EndDate>' + endTebra + '</ns:EndDate>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  var text = _tebraPost('GetAppointments', bodyXml);

  var doc = XmlService.parse(text);
  var root = doc.getRootElement();

  // Check auth failure (IsError is false on auth failures, so check Authenticated too)
  var secEls = [];
  _findXmlElements(root, 'SecurityResponse', secEls);
  if (secEls.length) {
    var authed = _findFirstXml(secEls[0], 'Authenticated');
    if (authed === 'false') {
      var secResult = _findFirstXml(secEls[0], 'SecurityResult') || 'Unknown';
      Logger.log('⚠️  GetAppointments auth failure: ' + secResult);
    }
  }

  var errEls = [];
  _findXmlElements(root, 'ErrorResponse', errEls);
  if (errEls.length && _getXmlChildText(errEls[0], 'IsError').toLowerCase() === 'true') {
    var errMsg = _getXmlChildText(errEls[0], 'ErrorMessage') ||
      _getXmlChildText(errEls[0], 'Message') || 'Unknown API error';
    throw new Error('Tebra API error: ' + errMsg);
  }

  var apptEls = [];
  _findXmlElements(root, 'AppointmentData', apptEls);
  Logger.log('Tebra returned ' + apptEls.length + ' total appointment elements.');

  // PatientState is sourced from the Patients tab via patientLookup — not from Tebra appointments.

  // Statuses that should update existing rows but NOT create new rows
  // Appointments with these Tebra statuses should update an existing row's
  // TebraStatus but should NOT create a new CRB row if no match is found.
  var NO_IMPORT_STATUS = {
    'cancelled': 1, 'canceled': 1,
    'deleted': 1,
    'no show': 1, 'noshow': 1, 'no-show': 1,
    'rescheduled': 1                       // moved to a new slot — don't duplicate
  };

  return apptEls.map(function (el) {
    var fullName = _findFirstXml(el, 'PatientFullName');
    var rawStart = _findFirstXml(el, 'StartDate');
    var tebraId = _findFirstXml(el, 'ID');
    var tebraPatientId = _findFirstXml(el, 'PatientID');   // NEW
    var resourceName1 = _findFirstXml(el, 'ResourceName1');
    var status = _findFirstXml(el, 'ConfirmationStatus');
    var insurance = _findFirstXml(el, 'PatientCaseName');
    var serviceLocation = _findFirstXml(el, 'ServiceLocationName');
    var serviceLocId = _findFirstXml(el, 'ServiceLocationID');

    var parsed = _parseTebraStartDate(rawStart);
    // Match by provider name (ResourceName1) — more reliable than ResourceID
    var crbProv = _matchTebraProvider(resourceName1);
    var patientName = _titleCase(_stripMiddleName(fullName));  // First + Last only — no middle names

    // _invalid: completely unusable — missing provider mapping, ZZZ test patient,
    // blank name, OR a known placeholder calendar-block entry (personal time
    // holds like "Jodene Mail" / "Kr Appt1" / "Lk Block" — see
    // PLACEHOLDER_PATIENT_NAMES). Checked here at the source so these never
    // reach the Appointments tab or trigger a Patients-tab upsert downstream.
    var _invalid = !crbProv || fullName.toUpperCase().indexOf('ZZZ') !== -1 || !fullName ||
      PLACEHOLDER_PATIENT_NAMES.indexOf(patientName.toUpperCase()) !== -1;
    // _statusOnly: has a valid appointment record but should only refresh status on existing rows
    var _statusOnly = !_invalid && !!NO_IMPORT_STATUS[(status || '').toLowerCase()];

    return {
      provID: crbProv,
      date: parsed.date,
      time: parsed.time,
      patient: patientName,
      tebraStatus: status,
      tebraApptId: tebraId,
      tebraPatientId: tebraPatientId,   // NEW
      insurance: insurance,           // primary insurance carrier from Tebra
      serviceLocation: serviceLocation,     // e.g. "Colorado - Solrei Behavioral Health, Inc."
      serviceLocId: serviceLocId,        // numeric Tebra service location ID (fallback lookup)
      resourceName1: resourceName1,       // kept for diagnostic logging
      _invalid: _invalid,
      _statusOnly: _statusOnly,
    };
  }).filter(function (a) {
    if (a._invalid) {
      if (!quiet) {
        var isPlaceholder = PLACEHOLDER_PATIENT_NAMES.indexOf((a.patient || '').toUpperCase()) !== -1;
        Logger.log(isPlaceholder
          ? '  Skipping placeholder calendar block: ' + a.patient + ' on ' + a.date
          : '  Invalid (unmapped provider "' + (a.resourceName1 || '?') + '" / no name): ' + a.patient + ' on ' + a.date);
      }
      return false;
    }
    if (!a.patient || !a.date || !a.time) {
      if (!quiet) Logger.log('  Skipping incomplete: ' + JSON.stringify(a));
      return false;
    }
    // Keep status-only records — they still go to importFromTebraApi for existing-row updates
    if (a._statusOnly && !quiet) {
      Logger.log('  Status-only [' + a.provID + '/' + a.tebraStatus + ']: ' +
        a.patient + ' on ' + a.date);
    }
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────
// DIAGNOSTIC: testStaleStatusCheck — read-only against the Sheet, and
// makes only a live GetAppointments (query) call to Tebra per sample
// date — no Tebra write endpoint is ever called, so this changes
// nothing in Tebra either. Uses _fetchTebraAppointments() directly —
// the SAME full Fields block (ConfirmationStatus/ID/PatientCaseID/
// PatientCaseName/PatientFullName/PatientID/ResourceID1/ResourceName1/
// StartDate) importFromTebraApi() itself uses in production, not the
// narrower 6-field block testTebraGetAppointments() uses (that one is
// missing PatientCaseID/PatientCaseName/PatientID and isn't what
// production actually relies on).
//
// For a hand-picked sample of dates, fetches Tebra's LIVE status for
// every one of provID's appointments that day, matches each one
// against the Sheet by the same identity (date+time+patient,
// normalized) deduplicateAppointments() uses, and logs the Sheet's
// stored TebraStatus/Signed side by side with what Tebra says right
// now. Directly tests the stale-sync-window theory: if Tebra already
// says Checked Out while the Sheet still shows something else, that's
// a real sync gap; if Tebra itself still shows an open status, the
// visit is genuinely unresolved, not a sync artifact.
//
// sampleDates defaults to a PROPOSED illustrative spread (weekly,
// early July → early August, comfortably outside the ~14-day rolling
// sync window) — swap in real dates pulled from testUnsignedRowList's
// actual output once you have it. Run this from Apps Script and check
// the Logs (View → Logs) after running.
// ─────────────────────────────────────────────────────────────────
function testStaleStatusCheck(provID, sampleDates) {
  provID = provID || 'jodene';
  sampleDates = sampleDates || [
    '2026-07-01', '2026-07-08', '2026-07-15',
    '2026-07-22', '2026-07-29', '2026-08-05',
  ];

  Logger.log('── testStaleStatusCheck for provID="' + provID + '" ──────────');
  Logger.log('  Sample dates: ' + sampleDates.join(', '));

  var c = _getTebraCreds();
  if (!c.customerKey) {
    Logger.log('❌  Run setTebraCreds() first.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('❌  No Appointments sheet found (or it has no data rows).');
      return;
    }

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var TIME_IDX = APPT_COLS.indexOf('Time');
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');

    // Build one Sheet lookup, scoped to provID only, keyed the same way
    // deduplicateAppointments() groups rows: date||time||normalizedPatient.
    var sheetRows = sheet.getDataRange().getValues();
    var sheetByKey = {};
    for (var i = 1; i < sheetRows.length; i++) {
      var r = sheetRows[i];
      if (String(r[PROV_IDX] || '').trim() !== String(provID).trim()) continue;
      var key = _fmtDate(r[DATE_IDX]) + '||' + _normalizeTimeKey(r[TIME_IDX]) + '||' +
        _stripMiddleName(String(r[PATIENT_IDX] || '').trim()).toLowerCase().replace(/\s+/g, ' ').trim();
      sheetByKey[key] = {
        rowNum: i + 1,
        tebraStatus: TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '',
        signedVal: r[SIGNED_IDX],
      };
    }

    var totalChecked = 0, totalMismatched = 0, totalNoSheetRow = 0;

    sampleDates.forEach(function (dateStr) {
      Logger.log('── ' + dateStr + ' — live Tebra fetch ──');
      var liveAppts;
      try {
        liveAppts = _fetchTebraAppointments(c, dateStr, dateStr);
      } catch (fetchErr) {
        Logger.log('  ❌  Fetch error: ' + fetchErr.message);
        return;
      }

      var forProv = liveAppts.filter(function (a) { return a.provID === provID; });
      if (!forProv.length) {
        Logger.log('  (no ' + provID + ' appointments returned for this date)');
        return;
      }

      forProv.forEach(function (a) {
        totalChecked++;
        var key = a.date + '||' + _normalizeTimeKey(a.time) + '||' +
          _stripMiddleName(a.patient).toLowerCase().replace(/\s+/g, ' ').trim();
        var sheetRow = sheetByKey[key];
        var initials = _initialsFor(a.patient);

        if (!sheetRow) {
          totalNoSheetRow++;
          Logger.log('  ⚠️  ' + a.date + ' ' + a.time + '  "' + initials + '"' +
            '  LIVE Tebra="' + a.tebraStatus + '"   — no matching Sheet row found');
          return;
        }

        var mismatch = String(sheetRow.tebraStatus || '') !== String(a.tebraStatus || '');
        if (mismatch) totalMismatched++;
        Logger.log('  ' + (mismatch ? '🔀' : '  ') + ' ' + a.date + ' ' + a.time +
          '  "' + initials + '"' +
          '  Sheet: TebraStatus="' + sheetRow.tebraStatus + '" Signed=' + JSON.stringify(sheetRow.signedVal) +
          '  |  LIVE Tebra: "' + a.tebraStatus + '"' +
          (mismatch ? '   ← MISMATCH' : ''));
      });
    });

    Logger.log('── Summary ──');
    Logger.log('  Total live appointments checked: ' + totalChecked);
    Logger.log('  Sheet/Tebra status mismatches:   ' + totalMismatched);
    Logger.log('  No matching Sheet row found:     ' + totalNoSheetRow);
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

// ─────────────────────────────────────────────────────────────────
// RECONCILIATION: reconcileStaleTebraStatuses — the write-capable
// sibling of testStaleStatusCheck(). Same live-fetch/match approach
// (_fetchTebraAppointments()'s full 9-field production shape, matched
// against the Sheet by date+time+patient identity), but for every
// mismatch found: dryRun=true logs it and stops there (zero writes);
// dryRun=false writes the corrected TebraStatus, then runs the SAME
// Checked-Out auto-sign condition importFromTebraApi()'s main loop
// uses — COL_SIGNED > 0 && _isCheckedOutStatus(newStatus) &&
// !alreadySigned — reusing _isCheckedOutStatus() itself directly. That
// block isn't a standalone callable function in importFromTebraApi()
// (it's inline, tied to that loop's own apptData/rowIdx/
// existingSignedMap batch-write variables), so the write here is a
// single targeted setValue() per row instead of a batch — the
// predicate and the idempotency guard are identical, only how the
// write reaches the sheet differs.
//
// dryRun follows importFromTebraApi()'s own convention exactly: last
// parameter, coerced with !!, defaults false (a live write) if
// omitted — so pass dryRun=true explicitly to preview first.
//
// Deliberately scoped to the genuine stale-sync-window backlog only —
// this only ever touches a row whose Sheet TebraStatus disagrees with
// what Tebra says right now. It never touches Signed directly except
// via that same Checked-Out condition, so the manual Signed-lag cases
// (blank/FALSE rows where Tebra's own status hasn't changed) are left
// completely untouched, per Dean's direction.
//
// Run this from Apps Script and check the Logs (View → Logs) after
// running. Strongly recommend dryRun=true first.
// ─────────────────────────────────────────────────────────────────
function reconcileStaleTebraStatuses(provID, startDateStr, endDateStr, dryRun) {
  provID = provID || 'jodene';
  dryRun = !!dryRun;

  Logger.log('── reconcileStaleTebraStatuses for provID="' + provID + '" ' +
    '[' + startDateStr + ' – ' + endDateStr + ']' +
    (dryRun ? '  (DRY RUN — no writes)' : '  (LIVE — will write)') + ' ──────────');

  if (!startDateStr || !endDateStr) {
    Logger.log('❌  startDateStr and endDateStr are required (YYYY-MM-DD).');
    return;
  }

  var c = _getTebraCreds();
  if (!c.customerKey) {
    Logger.log('❌  Run setTebraCreds() first.');
    return;
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('❌  No Appointments sheet found (or it has no data rows).');
      return;
    }

    var PROV_IDX = APPT_COLS.indexOf('ProvID');
    var TIME_IDX = APPT_COLS.indexOf('Time');
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');
    var TEBRA_IDX = APPT_COLS.indexOf('TebraStatus');
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX = APPT_COLS.indexOf('Date');
    var COL_TEBRA_STATUS = TEBRA_IDX + 1;   // 1-based sheet column
    var COL_SIGNED = SIGNED_IDX + 1;        // 1-based sheet column (Z)

    // Same Sheet lookup approach as testStaleStatusCheck(): one read,
    // scoped to provID, keyed by date||time||normalizedPatient.
    var sheetRows = sheet.getDataRange().getValues();
    var sheetByKey = {};
    for (var i = 1; i < sheetRows.length; i++) {
      var r = sheetRows[i];
      if (String(r[PROV_IDX] || '').trim() !== String(provID).trim()) continue;
      var key = _fmtDate(r[DATE_IDX]) + '||' + _normalizeTimeKey(r[TIME_IDX]) + '||' +
        _stripMiddleName(String(r[PATIENT_IDX] || '').trim()).toLowerCase().replace(/\s+/g, ' ').trim();
      sheetByKey[key] = {
        rowNum: i + 1,
        tebraStatus: TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '',
        signedVal: r[SIGNED_IDX],
      };
    }

    var totalChecked = 0, totalCorrected = 0, totalAutoSigned = 0;
    var tz = Session.getScriptTimeZone();
    var cur = _parseYMD(startDateStr);
    var end = _parseYMD(endDateStr);

    // ── Runtime elapsed-time guard, not a pre-sized day-count ──────────────
    // Apps Script's hard execution ceiling is 6 minutes. No real per-day
    // timing data was available to derive a "safe N days" number from (no
    // Logger output from an actual run has been shared), and a static
    // day-count would be wrong on an unusually heavy day regardless — a
    // runtime cutoff self-corrects no matter what the real per-day timing
    // turns out to be. Threshold: 4.5 minutes (270s) of the 6-minute
    // budget, checked at the START of every day's iteration (the finest
    // granularity practically available — each day's fetch is one
    // synchronous, non-interruptible call, so this can stop the loop
    // before a NEW day starts but can't abort a day already in flight).
    // The remaining ~1.5 minutes covers: that one already-permitted day's
    // fetch+processing finishing, the summary/audit/flush after the loop,
    // and general Apps Script latency variance.
    var MAX_ELAPSED_MS = 4.5 * 60 * 1000;
    var startTime = new Date().getTime();
    var lastCompletedDateStr = null;
    var stoppedEarly = false;

    while (cur <= end) {
      var elapsedMs = new Date().getTime() - startTime;
      if (elapsedMs >= MAX_ELAPSED_MS) {
        stoppedEarly = true;
        var stoppedAtStr = Utilities.formatDate(cur, tz, 'yyyy-MM-dd');
        Logger.log('⏱  Elapsed-time guard tripped at ' + Math.round(elapsedMs / 1000) +
          's — stopping before starting ' + stoppedAtStr + '.');
        Logger.log('   Last date fully completed: ' +
          (lastCompletedDateStr || '(none — stopped before completing any date)'));
        Logger.log('   Resume with startDateStr="' + stoppedAtStr + '".');
        break;
      }

      var dateStr = Utilities.formatDate(cur, tz, 'yyyy-MM-dd');
      Logger.log('── ' + dateStr + ' — live Tebra fetch ──');

      var liveAppts;
      try {
        // quiet=true — this function redacts patient identity to initials
        // in its own output; suppress _fetchTebraAppointments()'s own raw-
        // name narration lines for this call so none leak through.
        liveAppts = _fetchTebraAppointments(c, dateStr, dateStr, true);
      } catch (fetchErr) {
        // NOT marked as completed — the fetch itself failed, so this date
        // wasn't actually checked. A resume should retry it, not skip it.
        Logger.log('  ❌  Fetch error: ' + fetchErr.message);
        cur.setDate(cur.getDate() + 1);
        continue;
      }

      var forProv = liveAppts.filter(function (a) { return a.provID === provID; });
      if (!forProv.length) {
        Logger.log('  (no ' + provID + ' appointments returned for this date)');
        lastCompletedDateStr = dateStr;
        cur.setDate(cur.getDate() + 1);
        continue;
      }

      forProv.forEach(function (a) {
        totalChecked++;
        var key = a.date + '||' + _normalizeTimeKey(a.time) + '||' +
          _stripMiddleName(a.patient).toLowerCase().replace(/\s+/g, ' ').trim();
        var sheetRow = sheetByKey[key];
        var initials = _initialsFor(a.patient);

        if (!sheetRow) {
          Logger.log('  ⚠️  ' + a.date + ' ' + a.time + '  "' + initials + '"' +
            '  LIVE Tebra="' + a.tebraStatus + '"  — no matching Sheet row, skipped');
          return;
        }

        var oldStatus = sheetRow.tebraStatus || '';
        var newStatus = a.tebraStatus || '';
        if (oldStatus === newStatus) return;   // no mismatch, nothing to reconcile

        totalCorrected++;
        var alreadySigned = sheetRow.signedVal === true ||
          String(sheetRow.signedVal).trim().toUpperCase() === 'TRUE';
        var willAutoSign = COL_SIGNED > 0 && _isCheckedOutStatus(newStatus) && !alreadySigned;

        if (dryRun) {
          Logger.log('  🔀 [DRY RUN] row ' + sheetRow.rowNum + '  ' + a.date + ' ' + a.time +
            '  "' + initials + '"  TebraStatus: "' + oldStatus + '" → "' + newStatus + '"' +
            (willAutoSign ? '  (would also auto-sign)' : ''));
          return;
        }

        // ── LIVE write: correct TebraStatus ──
        sheet.getRange(sheetRow.rowNum, COL_TEBRA_STATUS).setValue(newStatus);
        Logger.log('  ✓ row ' + sheetRow.rowNum + '  ' + a.date + ' ' + a.time +
          '  "' + initials + '"  TebraStatus: "' + oldStatus + '" → "' + newStatus + '"');

        // ── Same Checked-Out auto-sign condition as importFromTebraApi()'s
        // main loop — see the block comment above this function. ──
        if (willAutoSign) {
          sheet.getRange(sheetRow.rowNum, COL_SIGNED).setValue(true);
          totalAutoSigned++;
          Logger.log('    ✓ Auto-signed: "' + initials + '" — TebraStatus "' +
            newStatus + '" → Signed=TRUE');
        }
      });

      lastCompletedDateStr = dateStr;
      cur.setDate(cur.getDate() + 1);
    }

    Logger.log('── Summary ──');
    Logger.log('  Total checked:          ' + totalChecked);
    Logger.log('  Total corrected:        ' + totalCorrected + (dryRun ? '  (dry run — no writes made)' : ''));
    Logger.log('  Of those, auto-signed:  ' + totalAutoSigned);
    Logger.log('  Range requested:        [' + startDateStr + ' – ' + endDateStr + ']');
    if (stoppedEarly) {
      Logger.log('  ⏱  STOPPED EARLY (elapsed-time guard) — last completed: ' +
        (lastCompletedDateStr || '(none)') + '. Resume with startDateStr="' +
        Utilities.formatDate(cur, tz, 'yyyy-MM-dd') + '".');
    } else {
      Logger.log('  ✅  Completed the full requested range.');
    }

    if (!dryRun && totalCorrected > 0) {
      SpreadsheetApp.flush();
      _audit(ss, 'TEBRA_STALE_RECONCILE',
        'reconcileStaleTebraStatuses: ' + totalCorrected + ' TebraStatus corrected, ' +
        totalAutoSigned + ' auto-signed (Checked Out → Signed=TRUE) — provID=' + provID +
        ' [' + startDateStr + ' – ' + (stoppedEarly ? lastCompletedDateStr : endDateStr) + ']' +
        (stoppedEarly ? ' (stopped early — elapsed-time guard)' : ''));
    }
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
  }
  Logger.log('────────────────────────────────────────────────────────────');
}

function _fetchTebraAppointmentsChunked(c, startDateStr, endDateStr) {
  var all = [];
  var seenKeys = {};
  var tz = Session.getScriptTimeZone();

  var chunkStart = _parseYMD(startDateStr);
  var rangeEnd = _parseYMD(endDateStr);

  while (chunkStart <= rangeEnd) {
    var chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    if (chunkEnd > rangeEnd) chunkEnd = new Date(rangeEnd);

    var sStr = Utilities.formatDate(chunkStart, tz, 'yyyy-MM-dd');
    var eStr = Utilities.formatDate(chunkEnd, tz, 'yyyy-MM-dd');
    Logger.log('  → Chunk: ' + sStr + ' – ' + eStr);

    var chunk = _fetchTebraAppointments(c, sStr, eStr);
    Logger.log('    Got ' + chunk.length + ' appointments in this chunk.');

    chunk.forEach(function (a) {
      var key = (a.tebraApptId || (a.provID + '|' + a.date + '|' + a.time));
      if (!seenKeys[key]) {
        seenKeys[key] = true;
        all.push(a);
      }
    });

    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  Logger.log('Chunked fetch complete: ' + all.length + ' unique appointments across full range.');
  return all;
}

function importFromTebraApi(startDateStr, endDateStr, dryRun) {
  try {
    // ── Kill switch check — abort immediately if API is disabled ─────────────
    if (!_isTebraApiEnabled()) {
      Logger.log('🔴 Tebra sync BLOCKED — API is disabled. Use the Billing Window toggle to re-enable.');
      return JSON.stringify({ error: 'Tebra API is currently disabled. Use the API toggle in the Billing Window to turn it on.' });
    }

    endDateStr = endDateStr || startDateStr;
    dryRun = !!dryRun;

    if (!startDateStr) {
      return JSON.stringify({ error: 'startDateStr is required (YYYY-MM-DD)' });
    }

    var c = _getTebraCreds();
    if (!c.customerKey) {
      return JSON.stringify({
        error: 'Tebra credentials not configured. ' +
          'Run setTebraCreds() in the Apps Script editor first.'
      });
    }

    var allAppts = [];
    var errors = [];
    var provResult = {};

    // Fetch service location → state map (GetServiceLocations, non-fatal).
    // Builds "Colorado - Solrei Behavioral Health, Inc." → "CO" etc.
    var svcLocMap = _fetchServiceLocationMap(c);

    try {
      allAppts = _fetchTebraAppointmentsChunked(c, startDateStr, endDateStr);
      allAppts.forEach(function (a) {
        provResult[a.provID] = (provResult[a.provID] || 0) + 1;
        if (!a.patientState) {
          // Try map lookup first (by name, then by ID), then direct parse as fallback
          a.patientState = (a.serviceLocation && svcLocMap.nameToState[a.serviceLocation])
            || (a.serviceLocId && svcLocMap.idToState[a.serviceLocId])
            || _extractStateFromLocationName(a.serviceLocation || '')
            || '';
        }
      });
      var withState = allAppts.filter(function (a) { return !!a.patientState; }).length;
      Logger.log('📍 PatientState resolved: ' + withState + '/' + allAppts.length + ' appointments');
    } catch (fetchErr) {
      errors.push(fetchErr.message);
      Logger.log('❌  _fetchTebraAppointmentsChunked error: ' + fetchErr.message);
    }

    var COL_APPTID = APPT_COLS.indexOf('ApptID');
    var COL_DATE = APPT_COLS.indexOf('Date');
    var COL_NOTES = APPT_COLS.indexOf('Notes');
    var COL_STATUS = APPT_COLS.indexOf('Status');
    var COL_LMOD = APPT_COLS.indexOf('LastModified');
    var COL_MODBY = APPT_COLS.indexOf('ModifiedBy');
    var NUM_COLS = APPT_COLS.length;
    var COL_DIRECT_INS = APPT_COLS.indexOf('DirectIns') + 1; // 1-based sheet column (M)
    var COL_TS_0BASED = APPT_COLS.indexOf('TebraStatus'); // 0-based — used by _findStaleRows'
    // idempotency check below, ahead of
    // the 1-based COL_TEBRA_STATUS declared
    // later for the main update loop.

    var activeTebraIds = {};
    var activeSlotKeys = {};   // provID||date||normalizedTime — same key format as the
    // main update loop below, so ID reassignment by Tebra
    // doesn't cause a false "stale" flag (see _findStaleRows).
    var canReconcile = errors.length === 0;
    if (canReconcile) {
      allAppts.forEach(function (a) {
        if (a.tebraApptId) activeTebraIds[String(a.tebraApptId)] = true;
        activeSlotKeys[a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time)] = true;
      });
    }

    var COL_PROV_ID = APPT_COLS.indexOf('ProvID');
    var COL_TIME = APPT_COLS.indexOf('Time');

    // ── PERFORMANCE (2026-07-25): _findStaleRows now takes an already-loaded,
    // full-width in-memory data block instead of re-reading the sheet itself —
    // avoids a redundant full-sheet read on top of the one already needed
    // below for the main update pass.
    //
    // ── FIX (2026-07-26): staleness used to be decided PURELY by whether the
    // row's original embedded Tebra ID (parsed from Notes at row-creation time)
    // still appeared in this sync's activeTebraIds set. But Tebra can silently
    // reassign an appointment's internal ID (e.g. on an internal edit) while the
    // appointment itself is still very much alive — the main update loop below
    // already handles this correctly by matching existing rows on
    // provID+date+time rather than on Tebra ID. _findStaleRows now applies that
    // SAME slot-key check as a second, authoritative signal: a row is only
    // truly stale if BOTH its old Tebra ID is gone AND its own slot no longer
    // appears anywhere in the current pull. This is what was silently flagging
    // legitimate Checked-Out appointments as "cancelled in tebra."
    function _findStaleRows(dataBlock, tebraSourceIds) {
      var stale = [];
      if (!canReconcile || !dataBlock || !dataBlock.length) return stale;

      dataBlock.forEach(function (row, i) {
        var apptId = String(row[COL_APPTID] || '');
        if (apptId.indexOf('TEBRA-API-') !== 0) return;

        var rowDate = _fmtDate(row[COL_DATE]);
        if (rowDate < startDateStr || rowDate > endDateStr) return;

        // CHANGED (2026-08-16): reads TEBRA_SOURCE_ID_COL directly instead of
        // regex-parsing Notes. Notes is user-editable (billing staff routinely
        // overwrite it), which silently broke this check for any row whose
        // Notes got reused for working notes. See legacy-orphan investigation.
        var tebraId = String((tebraSourceIds[i] && tebraSourceIds[i][0]) || '').trim();
        if (!tebraId) return; // not backfilled / never captured — nothing to check

        // Idempotency: skip rows already flagged by a previous sync run —
        // checked on Column AI (TebraStatus), not Column Y (Status),
        // since Column Y is Assistant-owned and no longer touched here.
        var tsExisting = String(row[COL_TS_0BASED] || '').toLowerCase().trim();
        if (tsExisting === 'deleted in tebra') return;

        if (activeTebraIds[tebraId]) return; // ID still present — definitely active

        // ID is gone, but the slot itself may still be active under a
        // different Tebra-assigned ID — check before flagging stale.
        var rowSlotKey = row[COL_PROV_ID] + '||' + rowDate + '||' +
          _normalizeTimeKey(row[COL_TIME]);
        if (activeSlotKeys[rowSlotKey]) return; // slot still active — not stale

        stale.push({
          patient: String(row[APPT_COLS.indexOf('Patient')] || ''),
          date: rowDate,
          tebraId: tebraId,
          sheetRow: i + 2,
        });
      });
      return stale;
    }

    if (dryRun) {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var apptSheet = ss.getSheetByName(TAB_APPT);

      Logger.log('DRY RUN — ' + allAppts.length + ' appointments from Tebra API.');
      allAppts.forEach(function (a) {
        Logger.log('  [' + a.provID + '] ' + a.date + '  ' + a.time + '  — ' + a.patient);
      });

      var dryRunBlock = (apptSheet && apptSheet.getLastRow() > 1)
        ? apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, NUM_COLS).getValues()
        : [];
      var tebraSourceIdsDry = (apptSheet && apptSheet.getLastRow() > 1)   // NEW
        ? apptSheet.getRange(2, TEBRA_SOURCE_ID_COL, apptSheet.getLastRow() - 1, 1).getValues()
        : [];
      var wouldFlag = _findStaleRows(dryRunBlock, tebraSourceIdsDry);
      if (wouldFlag.length) {
        Logger.log('Would flag ' + wouldFlag.length + ' stale appointments as "Deleted in Tebra" (TebraStatus, Column AI):');
        wouldFlag.forEach(function (s) {
          Logger.log('  ⚠️  ' + s.patient + ' on ' + s.date + ' (Tebra ID ' + s.tebraId + ')');
        });
      }

      return JSON.stringify({
        dryRun: true,
        parsed: allAppts.length,
        appointments: allAppts,
        providers: provResult,
        wouldFlag: wouldFlag,
        errors: errors,
      });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    if (!apptSheet) {
      return JSON.stringify({
        error: 'Appointments sheet not found — run initializeSheets() first.'
      });
    }

    var patientLookup = _buildPatientLookup(ss);
    Logger.log('Patient lookup: ' + Object.keys(patientLookup).length + ' patients');

    var existingRowMap = {};
    var existingTSMap = {};   // rowNum → current TebraStatus in sheet (for logging)
    var existingSignedMap = {};   // rowNum → current Signed boolean in sheet (for auto-reconcile)
    var existingPatientSet = {};   // lowercase patient name → true (has ≥1 appointment row)
    var existingPatientByRow = {};   // rowNum → lowercase patient name in that row
    var COL_TEBRA_STATUS = APPT_COLS.indexOf('TebraStatus') + 1; // 1-based sheet column
    var COL_SIGNED = APPT_COLS.indexOf('Signed') + 1;      // 1-based sheet column (Z)

    // ── PERFORMANCE (2026-07-25): this is THE fix for Full Sync's execution
    // time / "ScriptError ... INTERNAL" problem. Before, every existing-row
    // update below (TebraStatus, Signed auto-reconcile, DirectIns,
    // PatientState) made its own individual getRange()/setValue() call — for
    // a 146-day Full Sync window that could mean 1,000+ blocking round-trips
    // to the Sheets service in one execution. Now we read the ENTIRE
    // Appointments block ONCE into `apptData`, make every change as an
    // in-memory array mutation, and write the whole block back with a
    // SINGLE setValues() call after the loop (see below). Logic and every
    // rule are unchanged — only how the writes reach the sheet.
    var apptData = (apptSheet.getLastRow() > 1)
      ? apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, NUM_COLS).getValues()
      : [];

    // NEW (2026-08-17) — parallel read of TEBRA_PATIENT_ID_COL, same row range
    // as apptData. Kept separate because it lives outside APPT_COLS width.
    var existingPatientIds = (apptSheet.getLastRow() > 1)
      ? apptSheet.getRange(2, TEBRA_PATIENT_ID_COL, apptSheet.getLastRow() - 1, 1).getValues()
      : [];

    // Parallel read of INSURANCE_CARRIER_MANUAL_AT_COL, same row range and
    // same reasoning as existingPatientIds above — kept separate because it
    // lives outside APPT_COLS width. Checked before the DirectIns write
    // below skips a row entirely once a human has manually set its
    // InsuranceCarrier value.
    var existingInsuranceManualAt = (apptSheet.getLastRow() > 1)
      ? apptSheet.getRange(2, INSURANCE_CARRIER_MANUAL_AT_COL, apptSheet.getLastRow() - 1, 1).getValues()
      : [];

    apptData.forEach(function (r, i) {
      var key = r[0] + '||' + _fmtDate(r[1]) + '||' + _normalizeTimeKey(r[3]);
      var rowNum = i + 2; // 1-based sheet row (row 1 = header)
      // CHANGED (2026-08-19) — one slot can legitimately hold more than one
      // real patient (confirmed double-booking, not just stale rescheduling).
      // existingRowMap now holds an ARRAY of {rowNum, patientName} candidates
      // per slot instead of a single row number.
      if (!existingRowMap[key]) existingRowMap[key] = [];
      var ptName = String(r[4] || '').toLowerCase().replace(/\s+/g, ' ').trim(); // col E = Patient
      existingRowMap[key].push({ rowNum: rowNum, patientName: ptName });
      if (ptName) {
        existingPatientSet[ptName] = true;
        existingPatientByRow[rowNum] = ptName;
      }
      // Capture existing TebraStatus (0-based index = COL_TEBRA_STATUS - 1)
      if (COL_TEBRA_STATUS > 0 && r.length >= COL_TEBRA_STATUS) {
        existingTSMap[rowNum] = String(r[COL_TEBRA_STATUS - 1] || '');
      }
      // Capture existing Signed flag (0-based index = COL_SIGNED - 1)
      if (COL_SIGNED > 0 && r.length >= COL_SIGNED) {
        var _sv = r[COL_SIGNED - 1];
        existingSignedMap[rowNum] = (_sv === true || String(_sv).toUpperCase() === 'TRUE');
      }
    });

    // ── Deduplicate Tebra records ──────────────────────────────────────────
    // Tebra can return multiple records for the same patient+slot with different
    // statuses (e.g. a historical "Cancelled" entry AND a current "Scheduled" entry).
    // Before importing, collapse these to a single record per patient+slot, keeping
    // only the highest-priority status so the cancelled history never overwrites
    // the active booking.
    //
    // Priority (higher number wins):
    //   Check-out (10) > Confirmed (8) > Scheduled (7) > In Office (6)
    //   > No Show (3) > Rescheduled (2) > Cancelled/Deleted (1/0)
    // (2026-08-04: Confirmed and Scheduled were swapped — the lifecycle is
    // Scheduled → Confirmed → Checked-out, so a synced "Confirmed" status
    // must never be overwritten back down to "Scheduled" by dedup.)
    var _STATUS_PRI = {
      'check-out': 10, 'checkout': 10, 'checked out': 10, 'checkedout': 10,
      'confirmed': 8,
      'scheduled': 7,
      'in office': 6, 'inoffice': 6,
      'no show': 3, 'noshow': 3, 'no-show': 3,
      'rescheduled': 2,
      'cancelled': 1, 'canceled': 1,
      'deleted': 0
    };
    function _sPri(s) { return _STATUS_PRI[(s || '').toLowerCase().trim()] || 4; }

    var _dedupeMap = {};  // "provID||date||time||patientNorm" → index in dedupedAppts
    var dedupedAppts = [];
    allAppts.forEach(function (a) {
      // Normalize whitespace so "John  Smith" and "John Smith" collapse to the same key.
      var _ptNorm = (a.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
      var dk = a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time) +
        '||' + _ptNorm;
      if (!_dedupeMap.hasOwnProperty(dk)) {
        _dedupeMap[dk] = dedupedAppts.length;
        dedupedAppts.push(a);
      } else {
        var idx = _dedupeMap[dk];
        if (_sPri(a.tebraStatus) > _sPri(dedupedAppts[idx].tebraStatus)) {
          Logger.log('  ↑ Dedup: keeping "' + a.tebraStatus + '" over "' +
            dedupedAppts[idx].tebraStatus + '" for ' + a.patient + ' on ' + a.date);
          dedupedAppts[idx] = a;
        }
      }
    });
    if (dedupedAppts.length < allAppts.length) {
      Logger.log('  Deduplication: ' + allAppts.length + ' Tebra records → ' +
        dedupedAppts.length + ' unique patient+slot entries.');
    }
    // ── End deduplication ─────────────────────────────────────────────────

    var imported = 0;
    var skipped = 0;
    var statusUpdated = 0;
    var insuranceUpdated = 0;
    var autoSigned = 0;   // rows auto-flipped to Signed=TRUE because TebraStatus = Checked Out
    var newPatientsMap = {};   // key: lowercase full name → { firstName, lastName, insurance }

    // ── PERFORMANCE: new appointment rows are collected here and written in
    // ONE batched setValues() call after the loop, instead of one
    // setValues() + one setNumberFormat() call per row as before.
    var newRowsData = [];
    var newRowsTebraIds = [];      // parallel array, same order as newRowsData
    var newRowsPatientIds = [];    // NEW — parallel array, same order as newRowsData
    var firstNewRowNum = apptSheet.getLastRow() + 1;
    var nextNewRowNum = firstNewRowNum;

    dedupedAppts.forEach(function (appt) {
      var key = appt.provID + '||' + appt.date + '||' + _normalizeTimeKey(appt.time);

      // ── Track ALL valid patients for Patients tab check ────────────────
      // Do this before the existing-row branch so patients whose appointment
      // already exists (e.g. status changed Cancelled → Scheduled) are still
      // caught and added to the Patients tab if missing.
      var _ptNameLower = (appt.patient || '').toLowerCase();
      if (_ptNameLower && !patientLookup[_ptNameLower]) {
        if (!newPatientsMap[_ptNameLower]) {
          var _pts = appt.patient.trim().split(/\s+/);
          newPatientsMap[_ptNameLower] = {
            firstName: _pts[0] || '',
            lastName: _pts.slice(1).join(' ') || '',
            insurance: appt.insurance || '',
            patientId: appt.tebraPatientId || '',   // NEW
          };
        } else if (appt.insurance && !newPatientsMap[_ptNameLower].insurance) {
          // Prefer the first insurance value we encounter
          newPatientsMap[_ptNameLower].insurance = appt.insurance;
        }
      }
      // ─────────────────────────────────────────────────────────────────

      // CHANGED (2026-08-19) — replaces the old "slot-conflict guard," which
      // kept only ONE row per slot and treated every second real occupant as
      // a brand-new arrival on every single sync, silently creating a fresh
      // duplicate row each time (confirmed via ApptID timestamps ~11 days
      // apart on the same real appointment). Now: find whichever candidate
      // in this slot actually matches the incoming patient (fuzzy match via
      // _samePatient, so middle-name variants still merge correctly). No
      // match among however many real occupants this slot has → fall
      // through to create a new row, same as before.
      var incomingPt = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
      var _slotCandidates = existingRowMap[key] || [];
      var _match = _slotCandidates.find(function (c) {
        return c.patientName && incomingPt && _samePatient(c.patientName, incomingPt);
      });

      if (_match) {
        var rowNum = _match.rowNum;
        var rowIdx = rowNum - 2; // index into apptData
        var touched = false;

        // ── TebraStatus: ALWAYS overwrite with the latest value from Tebra.
        // Statuses are fluid — Scheduled → Confirmed → Check-out (or No Show,
        // Cancelled, Rescheduled). Never skip because a value already exists.
        if (appt.tebraStatus && COL_TEBRA_STATUS > 0) {
          var prevStatus = existingTSMap[rowNum] || '';
          apptData[rowIdx][COL_TEBRA_STATUS - 1] = appt.tebraStatus;
          existingTSMap[rowNum] = appt.tebraStatus; // keep in-memory map current
          statusUpdated++;
          touched = true;
          if (prevStatus !== appt.tebraStatus) {
            Logger.log('  ↻ TebraStatus: ' + appt.patient + ' (' + appt.date + ') ' +
              (prevStatus ? '"' + prevStatus + '" → ' : '[new] ') +
              '"' + appt.tebraStatus + '"');
          }

          // ── Auto-reconcile Signed flag with Tebra's "Checked Out" status.
          // Clinic standard (effective 2026-07-24): Checked Out = provider has
          // signed the note. When Tebra reports a row as Checked Out, SolBoard's
          // own Signed flag should automatically match — no manual double-entry.
          // Checked idempotently against current sheet state (not "did status
          // just change") so every sync also mops up any pre-existing backlog
          // of rows that are already Checked Out but not yet marked Signed.
          if (COL_SIGNED > 0 && _isCheckedOutStatus(appt.tebraStatus) &&
            !existingSignedMap[rowNum]) {
            apptData[rowIdx][COL_SIGNED - 1] = true;
            existingSignedMap[rowNum] = true;
            autoSigned++;
            touched = true;
            Logger.log('  ✓ Auto-signed: ' + appt.patient + ' (' + appt.date +
              ') — TebraStatus "' + appt.tebraStatus + '" → Signed=TRUE');
          }
        }

        // ── DirectIns: overwrite with Tebra's primary insurance carrier (PatientCaseName)
        // — UNLESS a human has manually set this row's InsuranceCarrier value
        // (INSURANCE_CARRIER_MANUAL_AT_COL populated), in which case the sync
        // skips this row's DirectIns entirely, permanently, not just this run.
        var _existingManualAt = String((existingInsuranceManualAt[rowIdx] && existingInsuranceManualAt[rowIdx][0]) || '').trim();
        if (appt.insurance && COL_DIRECT_INS > 0 && !_existingManualAt) {
          apptData[rowIdx][COL_DIRECT_INS - 1] = appt.insurance;
          insuranceUpdated++;
          touched = true;
        }

        // ── PatientState: stamp from Patients tab (primary source), only if
        // currently blank. Read directly from the in-memory block — no
        // separate getRange().getValue() round-trip needed anymore.
        var COL_PT_STATE = APPT_COLS.indexOf('PatientState') + 1; // 1-based
        var _ptLookupInfo = patientLookup[(appt.patient || '').toLowerCase()] || {};
        var _stateToWrite = appt.patientState || _ptLookupInfo.patientState || '';
        if (_stateToWrite && COL_PT_STATE > 0) {
          var existingState = String(apptData[rowIdx][COL_PT_STATE - 1] || '').trim();
          if (!existingState) {
            apptData[rowIdx][COL_PT_STATE - 1] = _stateToWrite;
            touched = true;
          }
        }

        // ── TebraPatientID: backfill only if currently blank (2026-08-17).
        // Lives outside apptData's width, so it's tracked in the parallel
        // existingPatientIds array and written back separately below.
        if (appt.tebraPatientId) {
          var _existingPid = String((existingPatientIds[rowIdx] && existingPatientIds[rowIdx][0]) || '').trim();
          if (!_existingPid) {
            existingPatientIds[rowIdx] = [appt.tebraPatientId];
            touched = true;
          }
        }

        if (!touched) skipped++;
        return;
      }

      // Don't create a new row for cancelled / no-show / deleted appointments —
      // UNLESS this patient has no appointment rows yet (brand-new or never synced).
      // We check existingPatientSet (built from the Appointments sheet) rather than
      // patientLookup (built from the Patients tab), because a patient can exist in
      // the Patients tab from a previous run but still have zero appointment rows.
      if (appt._statusOnly) {
        var _ptKey = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
        var _hasApptRow = !!existingPatientSet[_ptKey];
        if (_hasApptRow) { skipped++; return; }
        // No appointment row exists for this patient — create one so they appear in CRB.
        Logger.log('  ⚠ Patient has no appointment row yet, status "' + appt.tebraStatus + '" — creating row: ' + appt.patient);
      }

      // ── Reached row-creation path — log for diagnostics ─────────────
      Logger.log('  ➕ Creating row: ' + appt.patient +
        ' [' + appt.provID + '] ' + appt.date + ' ' + appt.time +
        ' status="' + appt.tebraStatus + '"' +
        ' _statusOnly=' + appt._statusOnly);

      var ptInfo = patientLookup[(appt.patient || '').toLowerCase()] || {};
      // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
      var method = ptInfo.method || '';
      var isDirect = method === 'direct';

      // Prefer insurance from Tebra API; fall back to local Patients tab entry
      var directInsValue = appt.insurance || ptInfo.insurance || '';
      // patientState: pre-resolved from ServiceLocationName via _fetchServiceLocationMap().
      // e.g. "Colorado - Solrei Behavioral Health, Inc." → "CO"
      // Falls back to Patients tab PatientState if resolution failed.
      var patientStateValue = appt.patientState || ptInfo.patientState || '';

      var apptId = 'TEBRA-API-' + new Date().getTime() + '-' +
        Math.random().toString(36).substr(2, 4).toUpperCase();

      var rowData = apptToRow({
        id: apptId,
        time: appt.time,
        patient: appt.patient,
        method: method,
        alma: { text: '', valid: null },
        hw: { text: '', valid: null },
        grow: { text: '', valid: null },
        directIns: directInsValue,
        intake: null,
        ins: null,
        autopay: null,
        scr: { 'PHQ-9': null, 'GAD-7': null, 'PCL-5': null },
        ccEhr: '',
        notes: 'Imported from Tebra API' +
          (appt.tebraApptId ? ' (ID:' + appt.tebraApptId + ')' : ''),
        unsigned: [],
        cpt: [],
        billing: 'pending',
        status: 'pending',
        out: false,
        paymentType: isDirect ? (ptInfo.patientPortion || '') : '',
        paymentRate: isDirect ? (ptInfo.rate || '') : '',
        paymentAmount: '',
        paymentCollected: false,
        paymentFailed: false,
        comms: [],
        tebraStatus: appt.tebraStatus || '',
        insuranceCarrier: directInsValue,
        patientState: patientStateValue,
      }, appt.provID, appt.date);

      var newRow = nextNewRowNum;
      nextNewRowNum++;
      newRowsData.push(rowData);
      newRowsTebraIds.push(appt.tebraApptId || '');
      newRowsPatientIds.push(appt.tebraPatientId || '');   // NEW

      existingRowMap[key] = newRow;
      // Register new patient in tracking maps so any subsequent Tebra records
      // for the same slot can correctly identify the patient in the new row.
      var _ptKeyNew = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
      existingPatientByRow[newRow] = _ptKeyNew;
      existingTSMap[newRow] = appt.tebraStatus || '';
      // ── Critical: update existingPatientSet so that any additional _statusOnly
      // records for this brand-new patient are not treated as "no row yet" and
      // don't create a second (or third) duplicate row.
      existingPatientSet[_ptKeyNew] = true;
      imported++;
    });

    // ── Stale-row cancellation flagging — mutates the SAME in-memory block
    // used above, so its writes ride along in the single batched write below.
    //
    // ── FIX (2026-07-26): this used to write 'cancelled in tebra' into
    // COL_STATUS — Column Y, the "Status" column. Column Y is Assistant-owned
    // (valid / pending / issue, entered only via the SolBoard Assistant UI —
    // pre-visit readiness) and must never be touched by the sync. A row whose
    // Tebra ID vanished from the feed is a TEBRA-side fact, so it belongs in
    // Column AI (TebraStatus) — the Tebra ground-truth column — using a value
    // distinct from Tebra's own real statuses ("Deleted in Tebra") so it's
    // never confused with an explicit Tebra "Cancelled". This value is wired
    // into _isVoidStatus() and the frontend's tsClass()/isVoidAppt() so it's
    // excluded from appointment + unsigned-note tallies exactly like No Show /
    // Rescheduled / Cancelled.
    var tebraSourceIds = (apptSheet.getLastRow() > 1)   // NEW
      ? apptSheet.getRange(2, TEBRA_SOURCE_ID_COL, apptSheet.getLastRow() - 1, 1).getValues()
      : [];
    var staleRows = _findStaleRows(apptData, tebraSourceIds);
    var flagged = 0;
    var now = new Date().toISOString();

    staleRows.forEach(function (s) {
      var rowIdx = s.sheetRow - 2;
      if (COL_TEBRA_STATUS > 0) {
        apptData[rowIdx][COL_TEBRA_STATUS - 1] = 'Deleted in Tebra';
      }
      apptData[rowIdx][COL_LMOD] = now;
      apptData[rowIdx][COL_MODBY] = 'Tebra Sync';
      flagged++;
      Logger.log('  ⚠️  Flagged deleted-from-Tebra: ' + s.patient + ' on ' + s.date +
        ' (Tebra ID ' + s.tebraId + ', sheet row ' + s.sheetRow + ')');
    });

    // ── PERFORMANCE: ONE batched write for every existing-row change made
    // above — TebraStatus, Signed auto-reconcile, DirectIns, PatientState,
    // and stale-cancel flags all ride in this single setValues() call,
    // replacing what used to be up to 5 individual API calls PER touched row.
    if (apptData.length) {
      apptSheet.getRange(2, 1, apptData.length, NUM_COLS).setValues(apptData);
    }

    // NEW (2026-08-17) — write back any TebraPatientID backfills from above
    if (existingPatientIds.length) {
      apptSheet.getRange(2, TEBRA_PATIENT_ID_COL, existingPatientIds.length, 1).setValues(existingPatientIds);
    }

    // ── PERFORMANCE: ONE batched write for every brand-new appointment row,
    // instead of one setValues() + one setNumberFormat() call per row.
    if (newRowsData.length) {
      var rowWidth = newRowsData[0].length;
      apptSheet.getRange(firstNewRowNum, 1, newRowsData.length, rowWidth).setValues(newRowsData);
      apptSheet.getRange(firstNewRowNum, 4, newRowsData.length, 1).setNumberFormat('@');

      apptSheet.getRange(firstNewRowNum, TEBRA_SOURCE_ID_COL, newRowsTebraIds.length, 1)
        .setValues(newRowsTebraIds.map(function (id) { return [id]; }));

      // NEW — write the real Tebra Patient ID into its own protected column
      apptSheet.getRange(firstNewRowNum, TEBRA_PATIENT_ID_COL, newRowsPatientIds.length, 1)
        .setValues(newRowsPatientIds.map(function (id) { return [id]; }));
    }

    // ── Add brand-new patients to Patients tab ────────────────────────
    // Any patient whose appointment was just imported but who had no record
    // in the Patients tab gets a new row created here so they appear in
    // autocomplete, patient search, and future lookups. Batched into one
    // setValues() call instead of one appendRow() per patient.
    var patientsCreated = 0;
    var patSheet = ss.getSheetByName(TAB_PATIENT);

    var newPatientKeys = Object.keys(newPatientsMap);
    if (patSheet && newPatientKeys.length > 0) {
      var newPatientRows = [];
      var newPatientRowIds = [];   // NEW — parallel array, same order as newPatientRows
      newPatientKeys.forEach(function (nameLower) {
        var pt = newPatientsMap[nameLower];
        // Guard: skip if they were somehow added to patientLookup between passes
        if (patientLookup[nameLower]) return;

        // PATIENT_COLS = ['FirstName','LastName','BillingChannel','InsuranceCarrier','CostShareClass','Rate']
        newPatientRows.push([
          pt.firstName,  // FirstName
          pt.lastName,   // LastName
          '',            // Platform — unknown from Tebra, staff can fill in
          pt.insurance,  // Insurance (from Tebra PatientCaseName)
          '',            // PatientPortion
          '',            // Rate
        ]);
        newPatientRowIds.push(pt.patientId || '');   // NEW — parallel array, same order
        patientsCreated++;

        // Add to in-memory lookup so the insurance-update pass below can find them.
        // Blank, not 'hw' — matches the blank Platform just written above; the
        // biller sets the real channel via Billing Channels in SolBoard, and
        // unknown appointments show as unselected rather than defaulting to
        // Headway (Solrei brand rule).
        patientLookup[nameLower] = {
          method: '',
          insurance: pt.insurance,
          patientPortion: '',
          rate: '',
        };

        Logger.log('  ✅ Added to Patients tab: ' + pt.firstName + ' ' + pt.lastName +
          (pt.insurance ? ' (Ins: ' + pt.insurance + ')' : ''));
      });
      if (newPatientRows.length) {
        var patStartRow = patSheet.getLastRow() + 1;
        patSheet.getRange(patStartRow, 1, newPatientRows.length, 6).setValues(newPatientRows);

        // NEW — write PatientID into its own column (index 18 → 1-based col 19)
        var PT_ID_COL = PATIENT_COLS.indexOf('PatientID') + 1;
        patSheet.getRange(patStartRow, PT_ID_COL, newPatientRowIds.length, 1)
          .setValues(newPatientRowIds.map(function (id) { return [id]; }));
      }
    }
    // ─────────────────────────────────────────────────────────────────

    // ── Update Patients tab Insurance column from Tebra ──────────────
    // Build a map of patient name → most recently seen PatientCaseName
    // across all appointments returned in this sync window. Batched into
    // one setValues() call instead of one setValue() per updated patient.
    var patientInsuranceMap = {};
    allAppts.forEach(function (a) {
      if (a.insurance && a.patient) {
        patientInsuranceMap[a.patient.toLowerCase()] = a.insurance;
      }
    });

    var patientsUpdated = 0;
    var COL_PT_FNAME = PATIENT_COLS.indexOf('FirstName');       // 0-based
    var COL_PT_LNAME = PATIENT_COLS.indexOf('LastName');        // 0-based
    var COL_PT_INS = PATIENT_COLS.indexOf('InsuranceCarrier'); // 0-based — in-memory mutation

    if (patSheet && patSheet.getLastRow() > 1 &&
      Object.keys(patientInsuranceMap).length > 0) {

      var ptLastRow = patSheet.getLastRow();
      var ptData = patSheet.getRange(2, 1, ptLastRow - 1, PATIENT_COLS.length).getValues();
      var ptTouched = false;

      ptData.forEach(function (row, i) {
        var first = String(row[COL_PT_FNAME] || '').trim();
        var last = String(row[COL_PT_LNAME] || '').trim();
        if (!first && !last) return;

        var fullName = _titleCase(first + ' ' + last).toLowerCase();
        var ins = patientInsuranceMap[fullName];
        if (ins) {
          row[COL_PT_INS] = ins;
          ptTouched = true;
          patientsUpdated++;
          Logger.log('  Patients tab: updated Insurance for ' + _titleCase(first + ' ' + last) +
            ' → ' + ins);
        }
      });

      if (ptTouched) {
        patSheet.getRange(2, 1, ptData.length, PATIENT_COLS.length).setValues(ptData);
      }
    }
    // ────────────────────────────────────────────────────────────────

    // ── Back-fill InsuranceCarrier (col 54) from DirectIns (col 13) ─────────
    // DirectIns is written on every sync from Tebra's PatientCaseName.
    // InsuranceCarrier is what Rate Analysis reads — keep it in sync.
    // This is non-fatal.
    try {
      backfillInsuranceCarrier(false);
    } catch (bcErr) {
      Logger.log('⚠️  InsuranceCarrier back-fill failed (non-fatal): ' + bcErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Sync PatientState from Tebra ─────────────────────────────────────────
    // Requires GetPatients/GetAllPatients API permission on the Tebra user.
    // If the account lacks that permission this silently no-ops — see
    // testPatientAuth_Try1_ClientVersion() for diagnosis.
    try {
      var patStateMap = _fetchTebraPatientStates(c);
      syncPatientStates(patStateMap, false);
    } catch (psErr) {
      Logger.log('⚠️  PatientState sync failed (non-fatal): ' + psErr.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    SpreadsheetApp.flush();
    _audit(ss, 'TEBRA_API_IMPORT',
      'Imported ' + imported + ', patientsCreated ' + patientsCreated +
      ', statusUpdated ' + statusUpdated +
      ', insuranceUpdated ' + insuranceUpdated +
      ', patientsUpdated ' + patientsUpdated +
      ', autoSigned ' + autoSigned +
      ', skipped ' + skipped + ', flagged ' + flagged +
      ' cancelled — Tebra API [' + startDateStr + ' – ' + endDateStr + ']');

    Logger.log('✅  Tebra API import: ' + imported + ' appts imported, ' +
      patientsCreated + ' new patients added to Patients tab, ' +
      statusUpdated + ' status refreshed, ' +
      insuranceUpdated + ' appt insurance updated (col M), ' +
      patientsUpdated + ' Patients tab insurance updated, ' +
      autoSigned + ' auto-signed (Checked Out → Signed=TRUE), ' +
      skipped + ' skipped, ' + flagged + ' flagged cancelled, ' +
      errors.length + ' errors.');

    return JSON.stringify({
      imported: imported,
      patientsCreated: patientsCreated,
      statusUpdated: statusUpdated,
      insuranceUpdated: insuranceUpdated,
      patientsUpdated: patientsUpdated,
      autoSigned: autoSigned,
      skipped: skipped,
      flagged: flagged,
      total: allAppts.length,
      providers: provResult,
      errors: errors,
    });

  } catch (e) {
    Logger.log('importFromTebraApi error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}




/* ── backfillPatientStatesFromTab ────────────────────────────────────────────
   One-time (or repeated) backfill: reads PatientState from the Patients tab and
   stamps it on every blank PatientState cell in the Appointments tab.
 
   Call manually:  backfillPatientStatesFromTab()
   Safe to re-run: only fills BLANK cells; never overwrites existing values.
 
   Reads the Patients tab HEADER ROW to locate PatientState dynamically, so
   it is robust even when the sheet layout differs from PATIENT_COLS constants.
   Only valid 2-letter US state codes are written — guards against accidental
   PrimarySubscriber or other non-state data contaminating the column.
────────────────────────────────────────────────────────────────────────────── */
function backfillPatientStatesFromTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var patSheet = ss.getSheetByName(TAB_PATIENT);
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!patSheet || !apptSheet) { Logger.log('❌  Sheet not found.'); return; }

  // ── Read ALL patient data (header + rows) and resolve column indices from header
  var ptAll = patSheet.getDataRange().getValues();
  if (ptAll.length < 2) { Logger.log('No patient rows.'); return; }
  var ptHdr = ptAll[0].map(function (h) { return String(h || '').trim(); });
  var COL_PT_FNAME = ptHdr.indexOf('FirstName'); if (COL_PT_FNAME < 0) COL_PT_FNAME = 0;
  var COL_PT_LNAME = ptHdr.indexOf('LastName'); if (COL_PT_LNAME < 0) COL_PT_LNAME = 1;
  var COL_PT_STATE = ptHdr.indexOf('PatientState'); if (COL_PT_STATE < 0) COL_PT_STATE = 12;
  Logger.log('backfillPatientStatesFromTab: PatientState column in Patients tab = index ' +
    COL_PT_STATE + ' (header: "' + ptHdr[COL_PT_STATE] + '")');

  // ── Build name → state map; only include valid 2-letter state codes
  var stateMap = {};
  var badValues = 0;
  ptAll.slice(1).forEach(function (r) {
    var first = String(r[COL_PT_FNAME] || '').trim();
    var last = String(r[COL_PT_LNAME] || '').trim();
    var raw = String(r[COL_PT_STATE] || '').trim();
    if (!raw) return;
    var state = raw.toUpperCase();
    if (!_isValidUSState(state)) {
      badValues++;
      Logger.log('  ⚠️  Skipping non-state value "' + raw + '" for patient: ' + first + ' ' + last);
      return;
    }
    if (first || last) stateMap[(first + ' ' + last).trim().toLowerCase()] = state;
  });
  Logger.log('backfillPatientStatesFromTab: ' + Object.keys(stateMap).length +
    ' patients have a valid state on Patients tab.' +
    (badValues ? ' (' + badValues + ' non-state values skipped — check PatientState column in Patients tab)' : ''));

  // ── Walk Appointments tab and fill blank PatientState cells
  var COL_APPT_PATIENT = APPT_COLS.indexOf('Patient');       // 0-based
  var COL_APPT_STATE = APPT_COLS.indexOf('PatientState');  // 0-based
  if (COL_APPT_PATIENT < 0 || COL_APPT_STATE < 0) {
    Logger.log('❌  Patient or PatientState column missing from APPT_COLS.'); return;
  }

  var lastRow = apptSheet.getLastRow();
  if (lastRow < 2) { Logger.log('No appointment rows.'); return; }

  var readCols = Math.max(COL_APPT_PATIENT, COL_APPT_STATE) + 1;
  var apptData = apptSheet.getRange(2, 1, lastRow - 1, readCols).getValues();
  var colState1 = COL_APPT_STATE + 1; // 1-based for setValues

  var updated = 0;
  apptData.forEach(function (r, i) {
    if (String(r[COL_APPT_STATE] || '').trim()) return; // already filled — skip
    var name = String(r[COL_APPT_PATIENT] || '').trim().toLowerCase();
    var state = stateMap[name];
    if (!state) return;
    apptSheet.getRange(i + 2, colState1).setValue(state);
    updated++;
  });

  SpreadsheetApp.flush();
  Logger.log('✅  backfillPatientStatesFromTab: ' + updated + ' appointment rows updated.');
}

/* ── cleanBadPatientStates ───────────────────────────────────────────────────
   Scans the Appointments tab PatientState column and CLEARS any cell that does
   NOT contain a valid 2-letter US state code (e.g., subscriber names that were
   accidentally written there by a previous backfill run).
   After running this, call backfillPatientStatesFromTab() to re-populate with
   correct state values.
 
   Run manually:  cleanBadPatientStates()
────────────────────────────────────────────────────────────────────────────── */
function cleanBadPatientStates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!apptSheet || apptSheet.getLastRow() < 2) {
    Logger.log('cleanBadPatientStates: No appointment rows found.'); return;
  }

  var COL_APPT_STATE = APPT_COLS.indexOf('PatientState'); // 0-based
  if (COL_APPT_STATE < 0) {
    Logger.log('❌  PatientState column not found in APPT_COLS.'); return;
  }

  var lastRow = apptSheet.getLastRow();
  var stateCol1 = COL_APPT_STATE + 1; // 1-based
  var stateVals = apptSheet.getRange(2, stateCol1, lastRow - 1, 1).getValues();
  var cleared = 0;
  var kept = 0;

  stateVals.forEach(function (row, i) {
    var v = String(row[0] || '').trim();
    if (!v) return; // already blank
    if (_isValidUSState(v)) { kept++; return; } // valid — leave it
    // Invalid value (e.g., subscriber name) — clear it
    apptSheet.getRange(i + 2, stateCol1).setValue('');
    Logger.log('  🧹 Cleared "' + v + '" from Appointments row ' + (i + 2));
    cleared++;
  });

  SpreadsheetApp.flush();
  Logger.log('✅  cleanBadPatientStates: ' + cleared + ' bad values cleared, ' +
    kept + ' valid state codes kept.');
  if (cleared > 0) {
    Logger.log('   → Now run backfillPatientStatesFromTab() to re-fill from Patients tab.');
  }
}


function _buildPatientLookup(ss) {
  var lookup = {};
  var PLATFORM_TO_METHOD = {
    'alma': 'alma', 'headway': 'hw', 'grow': 'grow', 'direct': 'direct'
  };
  var patSheet = ss.getSheetByName(TAB_PATIENT);
  if (patSheet && patSheet.getLastRow() > 1) {
    var allRows = patSheet.getDataRange().getValues();
    // ── Resolve column indices from actual header row so the lookup is robust
    //    even if PATIENT_COLS and the physical sheet columns have drifted apart.
    var hdr = allRows[0].map(function (h) { return String(h || '').trim(); });
    function col(name, fallback) {
      var idx = hdr.indexOf(name);
      return idx >= 0 ? idx : fallback;
    }
    var C_FIRST = col('FirstName', 0);
    var C_LAST = col('LastName', 1);
    var C_PLAT = col('BillingChannel', 2);
    var C_INS = col('InsuranceCarrier', 3);
    var C_PORTION = col('CostShareClass', 4);
    var C_RATE = col('Rate', 5);
    var C_CLMPLAT = col('ClaimGateway', 6);
    var C_MEMID = col('MemberID', 7);
    var C_DOB = col('MemberDOB', 8);
    var C_PCN = col('PCN', 9);
    var C_GROUP = col('GroupNumber', 10);
    var C_SUBSCR = col('PrimarySubscriber', 11);
    var C_STATE = col('PatientState', 12);
    var C_RNPI = col('RenderingNPI', 13);
    var C_BNPI = col('BillingNPI', 14);
    var C_XCODE = col('xCode', 15);

    allRows.slice(1).forEach(function (r) {
      var first = String(r[C_FIRST] || '').trim();
      var last = String(r[C_LAST] || '').trim();
      if (!first && !last) return;
      var fullName = (first + ' ' + last).trim().toLowerCase();
      var platform = String(r[C_PLAT] || '').trim().toLowerCase();
      var rawState = String(r[C_STATE] || '').trim().toUpperCase();
      lookup[fullName] = {
        // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
        method: PLATFORM_TO_METHOD[platform] || '',
        insurance: String(r[C_INS] || '').trim(),
        patientPortion: String(r[C_PORTION] || '').trim(),
        rate: _sv(r[C_RATE]).trim(),   // _sv preserves numeric 0 ($0 copay)
        claimPlatform: String(r[C_CLMPLAT] || '').trim(),
        memberID: String(r[C_MEMID] || '').trim(),
        // Sheets stores manually-entered dates as Date objects; convert to YYYY-MM-DD
        memberDOB: r[C_DOB] instanceof Date
          ? Utilities.formatDate(r[C_DOB], Session.getScriptTimeZone(), 'yyyy-MM-dd')
          : String(r[C_DOB] || '').trim(),
        pcn: String(r[C_PCN] || '').trim(),
        groupNumber: String(r[C_GROUP] || '').trim(),
        primarySubscriber: String(r[C_SUBSCR] || '').trim(),
        // Only store the state if it's a real 2-letter US state code —
        // guards against PrimarySubscriber or other data appearing in this cell.
        patientState: _isValidUSState(rawState) ? rawState : '',
        renderingNPI: String(r[C_RNPI] || '').trim(),
        billingNPI: String(r[C_BNPI] || '').trim(),
        xCode: String(r[C_XCODE] || '').trim(),
      };
    });
  }
  return lookup;
}


function repairTimeColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('Nothing to repair.');
    return;
  }

  var TIME_COL = APPT_COLS.indexOf('Time') + 1;
  var lastRow = sheet.getLastRow();
  var timeRange = sheet.getRange(2, TIME_COL, lastRow - 1, 1);
  var values = timeRange.getValues();

  var fixed = 0;
  var fixed_values = values.map(function (row) {
    var v = row[0];
    var norm = _fmtTime(v);
    if (norm !== String(v)) fixed++;
    return [norm];
  });

  timeRange.setNumberFormat('@');
  timeRange.setValues(fixed_values);

  SpreadsheetApp.flush();
  Logger.log('✅  repairTimeColumn: checked ' + values.length +
    ' rows, fixed ' + fixed + ' time cells.');
}


function runTebraApiImportToday() {
  var today = Utilities.formatDate(
    new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  Logger.log('Importing TODAY (' + today + ') from Tebra API...');
  var result = JSON.parse(importFromTebraApi(today, today, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}


function runTebraApiImportThisWeek() {
  var tz = Session.getScriptTimeZone();
  // tz-aware "today" — Session.getScriptTimeZone() -> Utilities.formatDate()
  // -> _parseYMD(), same construction already proven correct in
  // testTebraPatientCaseFields()/runTebraApiImportToday(), not a raw
  // `new Date()` whose local-time methods (getDay()/getDate()) resolve
  // against the Apps Script runtime's own default timezone instead of tz.
  var today = _parseYMD(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  var dow = today.getDay();
  var mon = new Date(today);
  mon.setDate(today.getDate() - ((dow + 6) % 7));
  var sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  var startStr = Utilities.formatDate(mon, tz, 'yyyy-MM-dd');
  var endStr = Utilities.formatDate(sun, tz, 'yyyy-MM-dd');

  Logger.log('Importing week ' + startStr + ' – ' + endStr + ' from Tebra API...');
  var result = JSON.parse(importFromTebraApi(startStr, endStr, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

function runTebraApiImportEightWeeks() {
  var tz = Session.getScriptTimeZone();
  // tz-aware "today" — same construction as runTebraApiImportThisWeek(),
  // not a raw `new Date()`. See that function's comment for why.
  var today = _parseYMD(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
  var dow = today.getDay();

  var lastMon = new Date(today);
  lastMon.setDate(today.getDate() - ((dow + 6) % 7) - 7);

  var eightWeeksOut = new Date(lastMon);
  eightWeeksOut.setDate(lastMon.getDate() + 55);

  var startStr = Utilities.formatDate(lastMon, tz, 'yyyy-MM-dd');
  var endStr = Utilities.formatDate(eightWeeksOut, tz, 'yyyy-MM-dd');

  Logger.log('Importing eight weeks ' + startStr + ' – ' + endStr + ' from Tebra API...');
  var result = JSON.parse(importFromTebraApi(startStr, endStr, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

// ── Full / Nuclear Tebra Sync ─────────────────────────────────────────────
// Called by the "⚡ Full Sync" button in the CRB header.
// Covers last 90 days through 8 weeks ahead across ALL providers.
// Use sparingly — this is a broad, slow operation intended for data recovery
// or after bulk scheduling changes. Normal day-to-day syncing uses
// importFromTebraApi() with a narrow date range.
function fullSyncTebraApi(startDateStr, endDateStr) {
  var tz = Session.getScriptTimeZone();
  // tz-aware "today" — same construction as runTebraApiImportThisWeek(),
  // not a raw `new Date()`. See that function's comment for why.
  var today = _parseYMD(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));

  // If the UI didn't pass explicit dates, build a sensible default range.
  if (!startDateStr) {
    var start = new Date(today);
    start.setDate(today.getDate() - 90);
    startDateStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  }
  if (!endDateStr) {
    var end = new Date(today);
    end.setDate(today.getDate() + 56); // +8 weeks
    endDateStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');
  }

  Logger.log('🔥 Full/Nuclear Tebra sync: ' + startDateStr + ' → ' + endDateStr);
  return importFromTebraApi(startDateStr, endDateStr, false);
}

// ── Overnight Scheduled Sync ──────────────────────────────────────────────────
// Called by the Apps Script time-based trigger (set to run between 1–2 am).
// Window: 2 weeks back → 4 weeks forward (42 days total).
// This is intentionally narrower than fullSyncTebraApi (which does 90 + 56 days)
// to keep nightly run time short and reduce API load / lockout risk.
// To change the window, adjust DAYS_BACK and DAYS_FORWARD below.
function overnightSyncTebraApi() {
  if (!_isTebraApiEnabled()) {
    Logger.log('🔴 Overnight Tebra sync SKIPPED — API is currently disabled.');
    return;
  }

  var DAYS_BACK = 14;  // 2 weeks back
  var DAYS_FORWARD = 28;  // 4 weeks forward

  var tz = Session.getScriptTimeZone();
  // tz-aware "today" — same construction as runTebraApiImportThisWeek(),
  // not a raw `new Date()`. This is the real, automated nightly sync,
  // running unattended on a 1-2am trigger — exactly the window where a
  // mismatch between the runtime's default timezone and tz would most
  // likely shift which calendar day "today" resolves to.
  var today = _parseYMD(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));

  var start = new Date(today); start.setDate(today.getDate() - DAYS_BACK);
  var end = new Date(today); end.setDate(today.getDate() + DAYS_FORWARD);

  var startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  var endStr = Utilities.formatDate(end, tz, 'yyyy-MM-dd');

  Logger.log('🌙 Overnight Tebra sync: ' + startStr + ' → ' + endStr +
    ' (' + DAYS_BACK + ' days back, ' + DAYS_FORWARD + ' days forward)');

  try {
    var result = JSON.parse(importFromTebraApi(startStr, endStr, false));
    Logger.log('✅ Overnight sync complete: ' + JSON.stringify(result));
    _audit(SpreadsheetApp.getActiveSpreadsheet(),
      'OVERNIGHT_SYNC_COMPLETE',
      'Overnight Tebra sync ' + startStr + '→' + endStr +
      ' — imported ' + (result.imported || 0) + ' appts.');
  } catch (e) {
    Logger.log('❌ Overnight sync FAILED: ' + e.message);
    _audit(SpreadsheetApp.getActiveSpreadsheet(),
      'OVERNIGHT_SYNC_FAILED',
      'Overnight Tebra sync failed: ' + e.message);
  }

  // Unsigned-note Signed/UnsignedDates safety net — piggybacks on this
  // existing nightly trigger rather than a new dedicated one (2026-08-04).
  try {
    nightlyReconcileUnsignedNotes();
  } catch (e) {
    Logger.log('❌ nightlyReconcileUnsignedNotes FAILED: ' + e.message);
    _audit(SpreadsheetApp.getActiveSpreadsheet(),
      'UNSIGNED_RECONCILE_FAILED',
      'Nightly unsigned-notes reconcile failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// deduplicateAppointments()
//
// One-shot cleanup: scans every row in the Appointments sheet, finds rows that
// share the same provider + date + time slot AND the same normalized patient
// name (first + last only, middle names ignored), and deletes all but the most
// data-complete row in each duplicate group.
//
// Run manually from the Apps Script editor after deploying the middle-name fix,
// or call it from overnightSyncTebraApi() once you're confident the per-run
// deduplication is working correctly.
//
// Safe to run multiple times (idempotent once duplicates are gone).
// ─────────────────────────────────────────────────────────────────────────────
function deduplicateAppointments() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet) {
    Logger.log('❌ deduplicateAppointments: sheet "' + TAB_APPT + '" not found.');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 3) {
    Logger.log('ℹ  deduplicateAppointments: fewer than 3 rows — nothing to do.');
    return;
  }

  var NUM_COLS = APPT_COLS.length;
  var PROV_IDX = APPT_COLS.indexOf('ProvID');    // 0
  var DATE_IDX = APPT_COLS.indexOf('Date');      // 1
  var TIME_IDX = APPT_COLS.indexOf('Time');      // 3
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');   // 4

  // Read all data rows (row 1 is the header)
  var allData = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();

  // ── Build slot groups ────────────────────────────────────────────────────
  // Key: "provID||YYYY-MM-DD||HH:MM"
  // Value: array of { rowNum (1-based), data, ptNorm (stripped first+last) }
  var slotGroups = {};

  allData.forEach(function (row, i) {
    var provID = String(row[PROV_IDX] || '').trim();
    var dateStr = _fmtDate(row[DATE_IDX]);
    var timeStr = _normalizeTimeKey(row[TIME_IDX]);
    var patient = String(row[PATIENT_IDX] || '').trim();

    if (!provID || !dateStr) return; // skip completely blank rows

    var slotKey = provID + '||' + dateStr + '||' + timeStr;
    // Strip middle name and lowercase for comparison
    var ptNorm = _stripMiddleName(patient).toLowerCase().replace(/\s+/g, ' ').trim();

    if (!slotGroups[slotKey]) slotGroups[slotKey] = [];
    slotGroups[slotKey].push({ rowNum: i + 2, data: row, ptNorm: ptNorm });
  });

  // ── Score function: prefer rows with more important fields filled in ──────
  // Notes removed from this list (2026-08-26) — Column U is being retired from
  // every internal dependency, not just frontend display, so its eventual
  // reservation/repurposing can't silently skew which duplicate row this
  // function keeps. The other 8 fields are untouched.
  var SCORE_COLS = [
    APPT_COLS.indexOf('Signed'),
    APPT_COLS.indexOf('CPTCodes'),
    APPT_COLS.indexOf('TebraStatus'),
    APPT_COLS.indexOf('BillingChannel'),
    APPT_COLS.indexOf('ApptID'),
    APPT_COLS.indexOf('ClaimStatus'),
    APPT_COLS.indexOf('ClaimPaidAmount'),
    APPT_COLS.indexOf('NoteStatus'),
  ].filter(function (idx) { return idx >= 0; });

  function _scoreRow(data) {
    var score = 0;
    SCORE_COLS.forEach(function (idx) {
      var v = data[idx];
      if (v !== undefined && v !== null && v !== '' && v !== false) score++;
    });
    return score;
  }

  // ── Find duplicates and decide which rows to delete ───────────────────────
  var rowsToDelete = []; // 1-based row numbers

  Object.keys(slotGroups).forEach(function (slotKey) {
    var entries = slotGroups[slotKey];
    if (entries.length < 2) return; // no duplicates in this slot

    // Sub-group entries by their normalized patient name.
    // Entries with the same first+last (ignoring middle names) are duplicates.
    var ptGroups = {};
    entries.forEach(function (e) {
      var k = e.ptNorm || '__empty__';
      if (!ptGroups[k]) ptGroups[k] = [];
      ptGroups[k].push(e);
    });

    Object.keys(ptGroups).forEach(function (ptKey) {
      var group = ptGroups[ptKey];
      if (group.length < 2) return; // only one row for this patient — fine

      // Sort best-row first (highest score = most data filled in)
      group.sort(function (a, b) { return _scoreRow(b.data) - _scoreRow(a.data); });

      var best = group[0];
      Logger.log('  🔀 Dup [' + slotKey + '] "' + ptKey + '"' +
        ' → keep row ' + best.rowNum +
        ' (score ' + _scoreRow(best.data) + ')' +
        ', delete: ' + group.slice(1).map(function (e) { return e.rowNum; }).join(', '));

      group.slice(1).forEach(function (e) { rowsToDelete.push(e.rowNum); });
    });
  });

  if (rowsToDelete.length === 0) {
    Logger.log('✅ deduplicateAppointments: no duplicates found — sheet is clean.');
    return;
  }

  // Delete from bottom up so row numbers above each deletion stay valid
  rowsToDelete.sort(function (a, b) { return b - a; });
  Logger.log('🗑  Deleting ' + rowsToDelete.length + ' duplicate row(s): ' +
    rowsToDelete.join(', '));

  rowsToDelete.forEach(function (rowNum) { sheet.deleteRow(rowNum); });

  _audit(ss, 'DEDUP_APPOINTMENTS',
    'Removed ' + rowsToDelete.length + ' duplicate appointment row(s).');

  Logger.log('✅ deduplicateAppointments: done — removed ' + rowsToDelete.length + ' rows.');
}


function runTebraApiImportDryRunThisWeek() {
  var tz = Session.getScriptTimeZone();
  var today = new Date();
  var dow = today.getDay();
  var mon = new Date(today);
  mon.setDate(today.getDate() - ((dow + 6) % 7));
  var sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  var startStr = Utilities.formatDate(mon, tz, 'yyyy-MM-dd');
  var endStr = Utilities.formatDate(sun, tz, 'yyyy-MM-dd');

  Logger.log('DRY RUN — week ' + startStr + ' – ' + endStr);
  var result = JSON.parse(importFromTebraApi(startStr, endStr, true));
  Logger.log('Would import ' + result.parsed + ' appointments:');
  (result.appointments || []).forEach(function (a, i) {
    Logger.log('  ' + (i + 1) + '. [' + a.provID + '] ' +
      a.date + '  ' + a.time + '  — ' + a.patient);
  });
  if (result.wouldFlag && result.wouldFlag.length) {
    Logger.log('Would flag ' + result.wouldFlag.length + ' as "cancelled in tebra":');
    result.wouldFlag.forEach(function (s) {
      Logger.log('  ⚠️  ' + s.patient + ' on ' + s.date);
    });
  }
  if (result.errors && result.errors.length) {
    Logger.log('Errors: ' + JSON.stringify(result.errors));
  }
}

function repairUnsignedColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data.'); return; }

  var COL_UNSIGNED = APPT_COLS.indexOf('UnsignedDates') + 1;
  var range = sheet.getRange(2, COL_UNSIGNED, lastRow - 1, 1);
  var values = range.getValues();
  var fixed = 0;

  var converted = values.map(function (row) {
    var v = row[0];
    if (v === null || v === undefined || v === '') return [''];
    if (v instanceof Date) {
      fixed++;
      var mo = v.getMonth() + 1;
      var dy = v.getDate();
      var yr = String(v.getFullYear()).slice(2);
      return [mo + '/' + dy + '/' + yr];
    }
    return [String(v)];
  });

  range.setNumberFormat('@');
  range.setValues(converted);
  SpreadsheetApp.flush();
  Logger.log('repairUnsignedColumn: forced text format on ' + values.length +
    ' cells; converted ' + fixed + ' Date objects to "M/D/YY" text.');
}


/**
 * ═══════════════════════════════════════════════════════
 *  DIAGNOSTIC: diagnoseNewPatient(patientName)
 * ═══════════════════════════════════════════════════════
 * Run this from Apps Script editor when a patient is not
 * appearing in the CRB after a Tebra refresh.
 *
 * Replace the name below with the actual patient name,
 * then click ▶ Run. Copy the full log output and share it.
 *
 * Example:
 *   function runDiagnose() { diagnoseNewPatient('Jane Smith'); }
 *   → run  runDiagnose
 */
function diagnoseNewPatient(patientName) {
  patientName = patientName || 'REPLACE WITH PATIENT NAME';
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var target = patientName.trim().toLowerCase();

  Logger.log('');
  Logger.log('══════════════════════════════════════════════');
  Logger.log('  diagnoseNewPatient: "' + patientName + '"');
  Logger.log('══════════════════════════════════════════════');

  // ── 1. PATIENTS TAB ───────────────────────────────────────────────
  Logger.log('\n── 1. Patients tab ──');
  var patSheet = ss.getSheetByName(TAB_PATIENT);
  var inPatientsTab = false;
  if (patSheet && patSheet.getLastRow() > 1) {
    var pRows = patSheet.getRange(2, 1, patSheet.getLastRow() - 1, 6).getValues();
    pRows.forEach(function (r, i) {
      var full = (String(r[0]) + ' ' + String(r[1])).trim().toLowerCase();
      if (full === target) {
        inPatientsTab = true;
        Logger.log('  ✅ FOUND in Patients tab (row ' + (i + 2) + ')');
        Logger.log('     FirstName="' + r[0] + '"  LastName="' + r[1] + '"  Platform="' + r[2] + '"  Insurance="' + r[3] + '"');
      }
    });
  }
  if (!inPatientsTab) Logger.log('  ❌ NOT found in Patients tab');

  // ── 2. APPOINTMENTS TAB ───────────────────────────────────────────
  Logger.log('\n── 2. Appointments tab ──');
  var apptSheet = ss.getSheetByName(TAB_APPT);
  var apptRows = [];
  if (apptSheet && apptSheet.getLastRow() > 1) {
    var aData = apptSheet.getDataRange().getValues();
    var headers = aData[0];
    for (var i = 1; i < aData.length; i++) {
      var r = aData[i];
      var ptCell = String(r[APPT_COLS.indexOf('Patient')] || '').trim().toLowerCase();
      if (ptCell !== target) continue;
      apptRows.push({ rowNum: i + 1, data: r });
      var provID = r[APPT_COLS.indexOf('ProvID')];
      var date = _fmtDate(r[APPT_COLS.indexOf('Date')]);
      var time = r[APPT_COLS.indexOf('Time')];
      var apptId = r[APPT_COLS.indexOf('ApptID')];
      var status = r[APPT_COLS.indexOf('Status')];
      var billing = r[APPT_COLS.indexOf('Billing')];
      var tebra = r[APPT_COLS.indexOf('TebraStatus')];
      var notes = r[APPT_COLS.indexOf('Notes')];
      Logger.log('  ✅ FOUND row ' + (i + 1) + ':');
      Logger.log('     ProvID="' + provID + '"');
      Logger.log('     Date="' + date + '"  (raw: ' + JSON.stringify(r[APPT_COLS.indexOf('Date')]) + ')');
      Logger.log('     Time="' + time + '"  key="' + _normalizeTimeKey(time) + '"');
      Logger.log('     ApptID="' + apptId + '"');
      Logger.log('     Status="' + status + '"');
      Logger.log('     Billing="' + billing + '"');
      Logger.log('     TebraStatus="' + tebra + '"');
      Logger.log('     Notes="' + String(notes || '').substring(0, 80) + '"');
      var sheetKey = String(provID) + '||' + date + '||' + _normalizeTimeKey(time);
      Logger.log('     existingRowMap key="' + sheetKey + '"');
    }
  }
  if (apptRows.length === 0) Logger.log('  ❌ NOT found in Appointments tab');
  else Logger.log('  Total appointment rows: ' + apptRows.length);

  // ── 3. WHAT TEBRA CURRENTLY RETURNS ──────────────────────────────
  Logger.log('\n── 3. Tebra API (next 14 days) ──');
  var tz = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 14);
  var futureStr = Utilities.formatDate(futureDate, tz, 'yyyy-MM-dd');
  var tebraMatches = [];
  try {
    var c = _getTebraCreds();
    var allTebra = _fetchTebraAppointments(c, todayStr, futureStr);
    allTebra.forEach(function (a) {
      if ((a.patient || '').toLowerCase() === target) {
        tebraMatches.push(a);
        var tebraKey = a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time);
        Logger.log('  ✅ FOUND in Tebra:');
        Logger.log('     patient="' + a.patient + '"');
        Logger.log('     provID="' + a.provID + '"');
        Logger.log('     date="' + a.date + '"');
        Logger.log('     time="' + a.time + '"  key="' + _normalizeTimeKey(a.time) + '"');
        Logger.log('     tebraStatus="' + a.tebraStatus + '"');
        Logger.log('     _statusOnly=' + a._statusOnly);
        Logger.log('     _invalid=' + a._invalid);
        Logger.log('     insurance="' + a.insurance + '"');
        Logger.log('     tebraKey="' + tebraKey + '"');

        // Does a matching sheet row exist?
        var matchedRow = apptRows.find(function (ar) {
          var k = String(ar.data[APPT_COLS.indexOf('ProvID')]) + '||' +
            _fmtDate(ar.data[APPT_COLS.indexOf('Date')]) + '||' +
            _normalizeTimeKey(ar.data[APPT_COLS.indexOf('Time')]);
          return k === tebraKey;
        });
        if (matchedRow) {
          Logger.log('     → Sheet row EXISTS (row ' + matchedRow.rowNum + ')  — would take existingRowMap path');
        } else {
          Logger.log('     → NO matching sheet row  — would attempt row creation (if not skipped)');
          if (a._statusOnly) {
            // Check existingPatientSet equivalent
            var hasAnyRow = apptRows.length > 0;
            Logger.log('     → _statusOnly=true  hasAnyApptRow=' + hasAnyRow +
              (hasAnyRow ? '  → WOULD BE SKIPPED ⚠' : '  → WOULD CREATE ROW ✅'));
          }
        }
      }
    });
    if (tebraMatches.length === 0) {
      Logger.log('  ❌ Patient NOT found in Tebra for ' + todayStr + ' – ' + futureStr);
      Logger.log('  (If appointment is outside this window, try a wider date range)');
    }
  } catch (e) {
    Logger.log('  ⚠ Tebra fetch error: ' + e.message);
  }

  // ── 4. SUMMARY ────────────────────────────────────────────────────
  Logger.log('\n── 4. Summary ──');
  Logger.log('  In Patients tab:     ' + (inPatientsTab ? 'YES' : 'NO'));
  Logger.log('  In Appointments tab: ' + (apptRows.length > 0 ? 'YES (' + apptRows.length + ' row(s))' : 'NO'));
  Logger.log('  Found in Tebra:      ' + (tebraMatches.length > 0 ? 'YES (' + tebraMatches.length + ' appt(s))' : 'NO'));
  Logger.log('══════════════════════════════════════════════');
}


/* ════════════════════════════════════════════════════════════════
   PATIENT CLAIM RECORD  — savePatientClaimRecord
   Writes static claim fields (ClaimPlatform, Insurance, MemberID,
   MemberDOB, PCN) back to the Patients tab for a given patient name.
   Called from the Claim Submit Modal and the Biller Appointment
   Modal in the Billing View.
════════════════════════════════════════════════════════════════ */
function savePatientClaimRecord(patientName, fieldsJson) {
  try {
    var fields = JSON.parse(fieldsJson || '{}');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: false, error: 'No patient sheet' });
    }

    var nameLower = (patientName || '').trim().toLowerCase();

    // ── Defensive header extension: ensure all PATIENT_COLS headers exist ──
    // This handles the case where the sheet was created before all columns were added.
    var headerRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    PATIENT_COLS.forEach(function (col, idx) {
      if (headerRow.indexOf(col) === -1) {
        var targetCol = idx + 1;  // 1-based column position per PATIENT_COLS order
        // Ensure sheet has enough columns
        while (sheet.getMaxColumns() < targetCol) sheet.insertColumnAfter(sheet.getMaxColumns());
        var cell = sheet.getRange(1, targetCol);
        cell.setValue(col);
        cell.setBackground('#3D768A').setFontColor('#FBFBF3').setFontWeight('bold');
      }
    });

    var numCols = Math.max(PATIENT_COLS.length, sheet.getLastColumn());
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(numCols, sheet.getLastColumn()))
      .getValues();

    var COL_CLAIM = PATIENT_COLS.indexOf('ClaimGateway') + 1;  // 1-based
    var COL_INS = PATIENT_COLS.indexOf('InsuranceCarrier') + 1;
    var COL_MEMID = PATIENT_COLS.indexOf('MemberID') + 1;
    var COL_DOB = PATIENT_COLS.indexOf('MemberDOB') + 1;
    var COL_PCN = PATIENT_COLS.indexOf('PCN') + 1;
    var COL_GROUP = PATIENT_COLS.indexOf('GroupNumber') + 1;
    var COL_SUB = PATIENT_COLS.indexOf('PrimarySubscriber') + 1;
    var COL_STATE = PATIENT_COLS.indexOf('PatientState') + 1;
    var COL_RNPI = PATIENT_COLS.indexOf('RenderingNPI') + 1;
    var COL_BNPI = PATIENT_COLS.indexOf('BillingNPI') + 1;
    var COL_XCODE = PATIENT_COLS.indexOf('xCode') + 1;
    var COL_PPLAT = PATIENT_COLS.indexOf('PaymentProcessingChannel') + 1;

    for (var i = 0; i < data.length; i++) {
      var fullName = (String(data[i][0] || '') + ' ' + String(data[i][1] || '')).trim().toLowerCase();
      if (fullName !== nameLower) continue;

      var rowNum = i + 2;

      // Helper: write a text value without Sheets coercing it to a number or date.
      // setNumberFormat('@') = "Plain text" — prevents leading-zero stripping and
      // date auto-detection before the value is written.
      function setPlainText(col, val) {
        if (col < 1) return;
        var cell = sheet.getRange(rowNum, col);
        cell.setNumberFormat('@');
        cell.setValue(val || '');
      }

      // Text/dropdown fields (no coercion risk — written as plain strings)
      if (COL_CLAIM > 0) sheet.getRange(rowNum, COL_CLAIM).setValue(fields.claimPlatform || '');
      if (COL_INS > 0) sheet.getRange(rowNum, COL_INS).setValue(fields.insurance || '');
      if (COL_SUB > 0) sheet.getRange(rowNum, COL_SUB).setValue(fields.primarySubscriber || '');
      if (COL_STATE > 0) sheet.getRange(rowNum, COL_STATE).setValue(fields.patientState || '');

      // Force plain text on DOB — prevents Sheets from re-interpreting YYYY-MM-DD as a date serial
      setPlainText(COL_DOB, fields.memberDOB);

      // Force plain text on all code/ID fields — preserves leading zeros
      setPlainText(COL_MEMID, fields.memberID);
      setPlainText(COL_PCN, fields.pcn);
      setPlainText(COL_GROUP, fields.groupNumber);
      setPlainText(COL_RNPI, fields.renderingNPI);
      setPlainText(COL_BNPI, fields.billingNPI);
      setPlainText(COL_XCODE, fields.xCode);
      if (COL_PPLAT > 0) sheet.getRange(rowNum, COL_PPLAT).setValue(fields.paymentPlatform || '');

      SpreadsheetApp.flush();
      Logger.log('savePatientClaimRecord: updated row ' + rowNum + ' for "' + patientName + '"');
      return JSON.stringify({ ok: true, row: rowNum });
    }

    Logger.log('savePatientClaimRecord: patient not found — "' + patientName + '"');
    return JSON.stringify({ ok: false, error: 'Patient not found: ' + patientName });
  } catch (e) {
    Logger.log('savePatientClaimRecord error: ' + e.message);
    return JSON.stringify({ ok: false, error: e.message });
  }
}

// savePatientBestChannel removed (2026-08-21, Stage D) — its only caller,
// ClaimSubmitModal's saveChannelToPatient(), was removed on the frontend
// when the old Best Rate mechanism was retired in favor of BestRatePopup.
// The BestChannel column itself (Patients tab, PATIENT_COLS index 17) is
// left untouched — never remove a live column position, only stop writing
// to it — so any historical data already in that column is preserved,
// just no longer read or written by anything.


// ── Get patient's current BillingChannel LABEL (2026-08-19) ────────────
// Minimal, single-purpose Patients-tab lookup — returns the label (e.g.
// "Headway") or '' if not found/not set. Deliberately NOT reusing
// _buildPatientLookup() (builds a full-roster lookup for Tebra sync, more
// than needed for a single-patient check) or _lookupPatient() (returns
// insurance/state, not channel — adding channel there would overload an
// unrelated shared helper). Used by saveAppointment()'s CREATE path to
// detect whether a manually-picked channel differs from the patient's
// existing default, matching the same name-matching style as
// setPatientBillingChannel() itself.
function _getPatientBillingChannelLabel(ss, patientName) {
  try {
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) return '';
    var nameLower = (patientName || '').trim().toLowerCase();
    var COL_CHAN = PATIENT_COLS.indexOf('BillingChannel');
    if (COL_CHAN < 0) return '';
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(COL_CHAN + 1, 2)).getValues();
    for (var i = 0; i < data.length; i++) {
      var fullName = (String(data[i][0] || '') + ' ' + String(data[i][1] || '')).trim().toLowerCase();
      if (fullName === nameLower) return String(data[i][COL_CHAN] || '').trim();
    }
    return '';
  } catch (e) {
    Logger.log('_getPatientBillingChannelLabel error (non-fatal): ' + e.message);
    return '';
  }
}


/* ════════════════════════════════════════════════════════════════
   SET PATIENT BILLING CHANNEL  — setPatientBillingChannel
   Updates the BillingChannel column (index 2, formerly "Platform")
   on the Patients tab — the patient's default claim-submission
   channel going forward. As of 2026-08-17 this IS also a retroactive
   edit: any of this patient's already-scheduled future appointments
   (across all providers) are updated in the same call — see below.

   Every night's Tebra Sync reads this Patients-tab value via
   _buildPatientLookup() / PLATFORM_TO_METHOD (internal helper name
   unchanged — see note above APPT_COLS on the scope of this
   terminology pass) and stamps it onto each *newly created*
   appointment row's BillingChannel column (Appointments tab, col F).

   PROPAGATION TO EXISTING ROWS (new, 2026-08-17): after writing the
   Patients-tab value, this function also batch-updates every
   Appointments-tab row for this patient, across ALL providers, where:
     - the row's Date is today or later, AND
     - the row's TebraStatus is not cancelled/canceled/deleted/no show/
       noshow/no-show (rescheduled and everything else IS included).
   For each such row whose current BillingChannel differs from the new
   short code, the channel is updated and that row's OLD channel's
   verification fields are cleared: AlmaText/AlmaValid (from 'alma'),
   HWText/HWValid (from 'hw'), GrowText/GrowValid (from 'grow'), or
   DirectValid only (from 'direct' — DirectIns holds the patient's
   insurance carrier name, not a verification note, and is always
   preserved). Rows already on the new channel, and past/cancelled
   rows, are left untouched. Intake/InsVerified/Autopay are never
   touched by this propagation. See _propagateBillingChannelToFuture
   Appointments() for the implementation.

   channel must be one of: '', 'Alma', 'Headway', 'Grow', 'Direct',
   'Unknown'. Blank and 'Unknown' are both accepted from the UI as
   "not yet determined" — both are normalized to '' on write, since
   PLATFORM_TO_METHOD already falls back to a blank BillingChannel
   for any value it doesn't recognize (Solrei brand rule: never default
   to Headway or any other channel).
════════════════════════════════════════════════════════════════ */
function setPatientBillingChannel(patientName, channel) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: false, error: 'No patient sheet' });
    }

    var ALLOWED = ['Alma', 'Headway', 'Grow', 'Direct'];
    var raw = String(channel || '').trim();
    var norm = raw.toLowerCase() === 'unknown' ? '' : raw;
    if (norm && ALLOWED.indexOf(norm) === -1) {
      return JSON.stringify({ ok: false, error: 'Invalid billing channel: ' + channel });
    }

    var nameLower = (patientName || '').trim().toLowerCase();
    var COL_CHAN = PATIENT_COLS.indexOf('BillingChannel') + 1;  // 1-based

    if (COL_CHAN < 1) {
      return JSON.stringify({ ok: false, error: 'BillingChannel column not in PATIENT_COLS' });
    }

    var numCols = Math.min(PATIENT_COLS.length, sheet.getLastColumn());
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(numCols, 2)).getValues();

    for (var i = 0; i < data.length; i++) {
      var fullName = (String(data[i][0] || '') + ' ' + String(data[i][1] || '')).trim().toLowerCase();
      if (fullName !== nameLower) continue;

      var rowNum = i + 2;
      var prior = String(data[i][2] || '').trim();
      sheet.getRange(rowNum, COL_CHAN).setValue(norm);
      SpreadsheetApp.flush();
      _audit(ss, 'setPatientBillingChannel', patientName + ': "' + (prior || '(blank)') + '" → "' + (norm || '(blank)') + '"');
      Logger.log('setPatientBillingChannel: row ' + rowNum + ' for "' + patientName + '" → "' + norm + '"');

      var newShortCode = PLATFORM_TO_METHOD[norm.toLowerCase()] || '';
      var propagation = _propagateBillingChannelToFutureAppointments(ss, patientName, newShortCode);
      _audit(ss, 'setPatientBillingChannel:propagateAppointments',
        patientName + ': "' + (prior || '(blank)') + '" → "' + (norm || '(blank)') + '" — ' +
        (propagation.count > 0
          ? propagation.count + ' future appointment row(s) updated (' + propagation.dates.join(', ') + ')'
          : 'no upcoming appointments to update'));

      return JSON.stringify({ ok: true, row: rowNum, channel: norm, updatedAppointments: propagation.count });
    }

    Logger.log('setPatientBillingChannel: patient not found — "' + patientName + '"');
    return JSON.stringify({ ok: false, error: 'Patient not found: ' + patientName });
  } catch (e) {
    Logger.log('setPatientBillingChannel error: ' + e.message);
    return JSON.stringify({ ok: false, error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   PROPAGATE BILLING CHANNEL TO FUTURE APPOINTMENTS
   — _propagateBillingChannelToFutureAppointments
   Called by setPatientBillingChannel() after a successful Patients-tab
   write. Scans the full Appointments tab (all providers) for rows
   belonging to this patient, dated today or later, whose TebraStatus
   is not a cancelled/deleted/no-show terminal status (rescheduled and
   everything else IS included). For each matching row whose current
   BillingChannel differs from newShortCode, stamps the new channel
   and clears that row's OLD channel's verification fields —
   AlmaText/AlmaValid, HWText/HWValid, GrowText/GrowValid, or
   DirectValid only (DirectIns is insurance data, not a verification
   note, and is always preserved). Rows already on the new channel are
   skipped untouched. Batch read + single batch write — no per-row
   setValue() calls, mirroring the Tebra sync's write pattern.

   Returns { count, dates } — count of rows changed and their (already
   _fmtDate-formatted) dates, for the caller's audit-log summary.
════════════════════════════════════════════════════════════════ */
function _propagateBillingChannelToFutureAppointments(ss, patientName, newShortCode) {
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!apptSheet || apptSheet.getLastRow() < 2) return { count: 0, dates: [] };

  var NUM_COLS = APPT_COLS.length;
  var IDX_DATE = APPT_COLS.indexOf('Date');
  var IDX_PATIENT = APPT_COLS.indexOf('Patient');
  var IDX_CHAN = APPT_COLS.indexOf('BillingChannel');
  var IDX_ALMA_TEXT = APPT_COLS.indexOf('AlmaText');
  var IDX_ALMA_VALID = APPT_COLS.indexOf('AlmaValid');
  var IDX_HW_TEXT = APPT_COLS.indexOf('HWText');
  var IDX_HW_VALID = APPT_COLS.indexOf('HWValid');
  var IDX_GROW_TEXT = APPT_COLS.indexOf('GrowText');
  var IDX_GROW_VALID = APPT_COLS.indexOf('GrowValid');
  var IDX_DIRECT_VALID = APPT_COLS.indexOf('DirectValid');
  var IDX_TEBRA_STATUS = APPT_COLS.indexOf('TebraStatus');

  // Same terminal-status vocabulary as the Tebra sync's dedup priority
  // dictionary (_STATUS_PRI) — rescheduled and anything else IS included.
  var TERMINAL_STATUSES = ['cancelled', 'canceled', 'deleted', 'no show', 'noshow', 'no-show'];

  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var nameNorm = _normName(patientName);

  var data = apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, NUM_COLS).getValues();

  var count = 0;
  var dates = [];
  var touched = false;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (_normName(row[IDX_PATIENT]) !== nameNorm) continue;
    if (_fmtDate(row[IDX_DATE]) < todayStr) continue;

    var ts = String(row[IDX_TEBRA_STATUS] || '').trim().toLowerCase();
    if (TERMINAL_STATUSES.indexOf(ts) !== -1) continue;

    var currentChan = String(row[IDX_CHAN] || '').trim().toLowerCase();
    if (currentChan === newShortCode) continue;

    if (currentChan === 'alma') {
      row[IDX_ALMA_TEXT] = '';
      row[IDX_ALMA_VALID] = '';
    } else if (currentChan === 'hw') {
      row[IDX_HW_TEXT] = '';
      row[IDX_HW_VALID] = '';
    } else if (currentChan === 'grow') {
      row[IDX_GROW_TEXT] = '';
      row[IDX_GROW_VALID] = '';
    } else if (currentChan === 'direct') {
      row[IDX_DIRECT_VALID] = '';
    }

    row[IDX_CHAN] = newShortCode;
    touched = true;
    count++;
    dates.push(_fmtDate(row[IDX_DATE]));
  }

  if (touched) {
    apptSheet.getRange(2, 1, data.length, NUM_COLS).setValues(data);
  }

  return { count: count, dates: dates };
}


/* ════════════════════════════════════════════════════════════════
   MIGRATION — migrateAddPatientClaimCols
   Run any time PATIENT_COLS grows — adds any missing header
   columns to the Patients tab (indices 6+).
   Safe to re-run — skips columns that already exist.
════════════════════════════════════════════════════════════════ */
function migrateAddPatientClaimCols() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_PATIENT);
  if (!sheet) { Logger.log('No Patients tab found.'); return; }

  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  // Derive from PATIENT_COLS — any column beyond the original 6 may need adding
  var newCols = PATIENT_COLS.slice(6);
  var added = 0;

  newCols.forEach(function (col) {
    if (headerRow.indexOf(col) === -1) {
      var nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue(col);
      // Style to match existing header formatting
      sheet.getRange(1, nextCol)
        .setBackground('#3D768A')
        .setFontColor('#FBFBF3')
        .setFontWeight('bold');
      headerRow.push(col);
      added++;
      Logger.log('Added column: ' + col + ' at position ' + nextCol);
    } else {
      Logger.log('Column already exists: ' + col);
    }
  });

  SpreadsheetApp.flush();
  Logger.log('migrateAddPatientClaimCols: done. Added ' + added + ' column(s).');
}

/* ════════════════════════════════════════════════════════════════
   PATIENT STATE SYNC
   Fetches patient address/state from the Tebra GetPatients API
   and stamps PatientState on both the Patients tab (col M) and
   the Appointments tab (col BC).
 
   Called automatically at the end of every importFromTebraApi run
   (nightly sync, auto-sync, and on-demand import).
 
   Also available as a standalone on-demand function:
     runSyncPatientStates()       — fills only blank/missing values
     runSyncPatientStatesForce()  — overwrites ALL existing values
════════════════════════════════════════════════════════════════ */

/**
 * Calls Tebra GetAllPatients API and returns a map keyed by
 * normalizedFullName → { state, insurance, providerName }
 *
 * Fixes from original _fetchTebraPatientStates:
 *   • Operation: GetPatients  → GetAllPatients  (correct Tebra call)
 *   • Fields:    Firstname    → FirstName       (case-sensitive)
 *                Lastname     → LastName
 *                AddressState → State
 *   • Added:     PrimaryInsurancePolicyCompanyName
 *                DefaultRenderingProviderFullName
 *   • Added:     Filter/BatchSize (required to get results)
 *
 * NOTE: If the response returns 0 patients, run testTebraGetPatientsRaw()
 * to inspect the raw XML — the container element or field names may differ
 * for this Tebra account.  Share the output to confirm.
 */
function _fetchTebraPatientStates(c) {
  var bodyXml =
    '<ns:GetAllPatients><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:FirstName>true</ns:FirstName>' +
    '<ns:LastName>true</ns:LastName>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:State>true</ns:State>' +
    '<ns:PrimaryInsurancePolicyCompanyName>true</ns:PrimaryInsurancePolicyCompanyName>' +
    '<ns:DefaultRenderingProviderFullName>true</ns:DefaultRenderingProviderFullName>' +
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:BatchSize>1000</ns:BatchSize>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAllPatients>';

  var text = _tebraPost('GetAllPatients', bodyXml);
  var doc = XmlService.parse(text);
  var root = doc.getRootElement();

  // Check for API-level errors
  var errEls = [];
  _findXmlElements(root, 'ErrorResponse', errEls);
  if (errEls.length && _getXmlChildText(errEls[0], 'IsError').toLowerCase() === 'true') {
    var errMsg = _getXmlChildText(errEls[0], 'ErrorMessage') ||
      _getXmlChildText(errEls[0], 'Message') || 'Unknown API error';
    throw new Error('Tebra GetAllPatients API error: ' + errMsg);
  }

  // Look for patient elements — Tebra may wrap them as PatientData, Patient,
  // or PatientBatchData (confirmed 2026-08-26 via testTebraGetPatientsRaw()'s
  // raw response for this account — neither of the first two matched).
  var patientEls = [];
  _findXmlElements(root, 'PatientData', patientEls);
  if (patientEls.length === 0) {
    _findXmlElements(root, 'Patient', patientEls);
    if (patientEls.length > 0) {
      Logger.log('ℹ️  Found patient records under <Patient> (not <PatientData>).');
    }
  }
  if (patientEls.length === 0) {
    _findXmlElements(root, 'PatientBatchData', patientEls);
    if (patientEls.length > 0) {
      Logger.log('ℹ️  Found patient records under <PatientBatchData> (not <PatientData> or <Patient>).');
    }
  }
  Logger.log('Tebra GetAllPatients returned ' + patientEls.length + ' patients.');

  if (patientEls.length === 0) {
    Logger.log('⚠️  Zero patients returned. Run testTebraGetPatientsRaw() to inspect ' +
      'the raw XML and confirm the correct container element name.');
    return {};
  }

  var patientMap = {};
  patientEls.forEach(function (el) {
    // Name — prefer PatientFullName, fall back to FirstName + LastName
    var fullNameRaw = (_findFirstXml(el, 'PatientFullName') || '').trim();
    var first = (_findFirstXml(el, 'FirstName') || '').trim();
    var last = (_findFirstXml(el, 'LastName') || '').trim();

    if (!fullNameRaw && !first && !last) return;

    var nameKey = fullNameRaw
      ? _normName(fullNameRaw)
      : _normName(first + ' ' + last);
    if (!nameKey) return;

    var state = (_findFirstXml(el, 'State') || '').trim().toUpperCase();
    var ins = (_findFirstXml(el, 'PrimaryInsurancePolicyCompanyName') || '').trim();
    var provName = (_findFirstXml(el, 'DefaultRenderingProviderFullName') || '').trim();

    // Keep first occurrence; update only if a later record has more data
    if (!patientMap[nameKey]) {
      patientMap[nameKey] = { state: state, insurance: ins, providerName: provName };
    } else {
      if (state && !patientMap[nameKey].state) patientMap[nameKey].state = state;
      if (ins && !patientMap[nameKey].insurance) patientMap[nameKey].insurance = ins;
      if (provName && !patientMap[nameKey].providerName) patientMap[nameKey].providerName = provName;
    }
  });

  Logger.log('Patient map built: ' + Object.keys(patientMap).length +
    ' unique patients from Tebra.');

  // Log a sample for verification
  var sample = Object.keys(patientMap).slice(0, 5);
  sample.forEach(function (k) {
    var d = patientMap[k];
    Logger.log('  "' + k + '" → state=' + (d.state || '—') +
      ', ins=' + (d.insurance || '—') +
      ', prov=' + (d.providerName || '—'));
  });

  return patientMap;
}


/* ════════════════════════════════════════════════════════════════
   INSURANCE CARRIER BACK-FILL
   Bridges DirectIns (col M, index 12) → InsuranceCarrier (col 54).
   DirectIns is already populated from Tebra's PatientCaseName on every
   appointment sync.  InsuranceCarrier is what Rate Analysis reads — but
   it is only written via saveAppointment(), not by the import.
   This function closes that gap without needing the Patient API.
════════════════════════════════════════════════════════════════ */

/**
 * Back-fills InsuranceCarrier (APPT_COLS index 53, 1-based col 54) from:
 *   1. DirectIns on the same appointment row (populated by Tebra appointment sync)
 *   2. Patients tab Insurance column (fallback by patient name match)
 *
 * Also updates InsuranceCarrier in rows that already have a DirectIns value
 * (since DirectIns may have changed since the last save).
 *
 * @param {boolean} forceOverwrite  true = overwrite existing values.
 *                                  false = only fill blank cells (default).
 */
function backfillInsuranceCarrier(forceOverwrite) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patSheet = ss.getSheetByName(TAB_PATIENT);
    if (!apptSheet || apptSheet.getLastRow() < 2) {
      return JSON.stringify({ updated: 0 });
    }

    // ── Column indices ────────────────────────────────────────────────────────
    var IDX_PATIENT = APPT_COLS.indexOf('Patient');          // 0-based (4)
    var IDX_DIRECT_INS = APPT_COLS.indexOf('DirectIns');        // 0-based (12)
    var IDX_INS_CARR = APPT_COLS.indexOf('InsuranceCarrier'); // 0-based (53)
    var COL_INS_CARR = IDX_INS_CARR + 1;                     // 1-based

    // ── Build name → insurance map from Patients tab ─────────────────────────
    var patInsMap = {};
    var COL_PT_FNAME = PATIENT_COLS.indexOf('FirstName');  // 0
    var COL_PT_LNAME = PATIENT_COLS.indexOf('LastName');   // 1
    var COL_PT_INS = PATIENT_COLS.indexOf('InsuranceCarrier');  // 3

    if (patSheet && patSheet.getLastRow() > 1) {
      patSheet.getRange(2, 1, patSheet.getLastRow() - 1, PATIENT_COLS.length)
        .getValues()
        .forEach(function (r) {
          var first = String(r[COL_PT_FNAME] || '').trim();
          var last = String(r[COL_PT_LNAME] || '').trim();
          var ins = String(r[COL_PT_INS] || '').trim();
          if ((first || last) && ins) {
            patInsMap[_normName(first + ' ' + last)] = ins;
          }
        });
    }
    Logger.log('backfillInsuranceCarrier: Patients tab insurance map has ' +
      Object.keys(patInsMap).length + ' entries.');

    // ── Scan Appointments tab ─────────────────────────────────────────────────
    var lastRow = apptSheet.getLastRow();
    var numRows = lastRow - 1;
    var apptData = apptSheet.getRange(2, 1, numRows, APPT_COLS.length).getValues();
    var updated = 0;

    // Parallel read of INSURANCE_CARRIER_MANUAL_AT_COL, same row range and
    // reasoning as the other standalone-column parallel reads in this file
    // (e.g. importFromTebraApi's existingPatientIds) — outside APPT_COLS
    // width. Checked unconditionally, even under forceOverwrite: once a
    // human has manually set a row's InsuranceCarrier, this function must
    // never touch it again, not even via the explicit force runner.
    var manualAtCol = apptSheet.getRange(2, INSURANCE_CARRIER_MANUAL_AT_COL, numRows, 1).getValues();

    apptData.forEach(function (row, i) {
      var manuallySet = String((manualAtCol[i] && manualAtCol[i][0]) || '').trim();
      if (manuallySet) return;  // human-set — never touched by this function, force or not

      var existing = String(row[IDX_INS_CARR] || '').trim();
      if (existing && !forceOverwrite) return;  // already populated — skip unless force

      // Source 1: DirectIns on this row (from Tebra appointment sync)
      var directIns = String(row[IDX_DIRECT_INS] || '').trim();
      var carrier = directIns;

      // Source 2: Patients tab fallback by patient name
      if (!carrier) {
        var patName = _normName(String(row[IDX_PATIENT] || ''));
        carrier = patInsMap[patName] || '';
      }

      if (!carrier) return;

      apptSheet.getRange(i + 2, COL_INS_CARR).setValue(carrier);
      updated++;
    });

    SpreadsheetApp.flush();
    Logger.log('✅  backfillInsuranceCarrier: ' + updated + ' InsuranceCarrier cells updated' +
      (forceOverwrite ? ' (force overwrite)' : ' (blanks only)') + '.');

    return JSON.stringify({ updated: updated });

  } catch (e) {
    Logger.log('backfillInsuranceCarrier error: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Standalone runner — fills blank InsuranceCarrier cells only.
 * Run once from Apps Script to back-fill all historical appointments.
 */
function runBackfillInsuranceCarrier() {
  Logger.log('=== Back-filling InsuranceCarrier (blanks only) ===');
  var r = JSON.parse(backfillInsuranceCarrier(false));
  Logger.log('Result: ' + JSON.stringify(r));
}

/**
 * Force-overwrites ALL InsuranceCarrier cells with the freshest DirectIns value.
 * Use when insurance names in Tebra have been corrected and you want them
 * reflected across all historical appointments.
 */
function runBackfillInsuranceCarrierForce() {
  Logger.log('=== Force back-filling InsuranceCarrier (all rows) ===');
  var r = JSON.parse(backfillInsuranceCarrier(true));
  Logger.log('Result: ' + JSON.stringify(r));
}


/**
 * Main sync function — stamps patient data from Tebra onto both sheets.
 *
 * Patients tab (PATIENT_COLS):
 *   col 4  (Insurance)    → PrimaryInsurancePolicyCompanyName
 *   col 13 (PatientState) → State
 *
 * Appointments tab (APPT_COLS):
 *   col 54 (InsuranceCarrier) → patient's insurance (back-filled from patient map)
 *   col 55 (PatientState)     → State (back-filled from patient map)
 *
 * @param {Object|null}  tebraPatientMap  Pre-built name→{state,insurance,providerName} map.
 *                                        Pass null to fetch fresh from Tebra.
 * @param {boolean}      forceOverwrite   true  = overwrite ALL rows, even if already populated.
 *                                        false = only fill blank cells (default).
 */
function syncPatientStates(tebraPatientMap, forceOverwrite) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Fetch from Tebra if no pre-built map was provided
    if (!tebraPatientMap) {
      var c = _getTebraCreds();
      if (!c.customerKey) {
        Logger.log('❌  syncPatientStates: Tebra credentials not set. Run setTebraCreds() first.');
        return JSON.stringify({ error: 'Tebra credentials not configured.' });
      }
      tebraPatientMap = _fetchTebraPatientStates(c);
    }

    var mapSize = Object.keys(tebraPatientMap || {}).length;
    if (!mapSize) {
      Logger.log('⚠️  syncPatientStates: no patient data returned from Tebra. ' +
        'Run testTebraGetPatientsRaw() to diagnose.');
      return JSON.stringify({ patientsUpdated: 0, appointmentsUpdated: 0 });
    }
    Logger.log('syncPatientStates: working with ' + mapSize + ' patients from Tebra map.');

    var patSheet = ss.getSheetByName(TAB_PATIENT);
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patientsUpdated = 0;
    var appointmentsUpdated = 0;

    // ── Column indices (0-based for reading, 1-based for writing) ──────────────
    var COL_PT_FNAME = PATIENT_COLS.indexOf('FirstName');     // 0-based
    var COL_PT_LNAME = PATIENT_COLS.indexOf('LastName');      // 0-based
    var COL_PT_INS_IDX = PATIENT_COLS.indexOf('InsuranceCarrier'); // 0-based (index 3)
    var COL_PT_STATE_IDX = PATIENT_COLS.indexOf('PatientState');  // 0-based (index 12)
    var COL_PT_INS = COL_PT_INS_IDX + 1;                 // 1-based for setRange
    var COL_PT_STATE = COL_PT_STATE_IDX + 1;                 // 1-based for setRange

    // ── 1. Update Patients tab ────────────────────────────────────────────────
    if (patSheet && patSheet.getLastRow() > 1 && COL_PT_STATE > 0) {
      var ptData = patSheet.getRange(2, 1, patSheet.getLastRow() - 1, PATIENT_COLS.length).getValues();
      ptData.forEach(function (row, i) {
        var first = String(row[COL_PT_FNAME] || '').trim();
        var last = String(row[COL_PT_LNAME] || '').trim();
        if (!first && !last) return;

        var nameKey = _normName(first + ' ' + last);
        var tebraData = tebraPatientMap[nameKey];
        if (!tebraData) return;

        var rowNum = i + 2;
        var existingState = String(row[COL_PT_STATE_IDX] || '').trim();
        var existingIns = String(row[COL_PT_INS_IDX] || '').trim();
        var anyUpdate = false;

        if (tebraData.state && (forceOverwrite || !existingState)) {
          patSheet.getRange(rowNum, COL_PT_STATE).setValue(tebraData.state);
          anyUpdate = true;
        }
        if (tebraData.insurance && (forceOverwrite || !existingIns)) {
          patSheet.getRange(rowNum, COL_PT_INS).setValue(tebraData.insurance);
          anyUpdate = true;
        }

        if (anyUpdate) {
          patientsUpdated++;
          Logger.log('  Patients tab: ' + _titleCase(first + ' ' + last) +
            ' → state=' + (tebraData.state || '—') +
            ', ins=' + (tebraData.insurance || '—'));
        }
      });
    }

    // ── 2. Back-fill Appointments tab ─────────────────────────────────────────
    var COL_APPT_PAT_IDX = APPT_COLS.indexOf('Patient');           // 0-based (4)
    var COL_APPT_INS_IDX = APPT_COLS.indexOf('InsuranceCarrier');  // 0-based (53)
    var COL_APPT_ST_IDX = APPT_COLS.indexOf('PatientState');      // 0-based (54)
    var COL_APPT_INS = COL_APPT_INS_IDX + 1;                  // 1-based
    var COL_APPT_STATE = COL_APPT_ST_IDX + 1;                  // 1-based

    if (apptSheet && apptSheet.getLastRow() > 1 && COL_APPT_STATE > 0) {
      var apptData = apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, APPT_COLS.length).getValues();
      // Parallel read of INSURANCE_CARRIER_MANUAL_AT_COL, outside APPT_COLS
      // width, same reasoning as backfillInsuranceCarrier()'s equivalent —
      // checked unconditionally, even under forceOverwrite, guarding only
      // the InsuranceCarrier write below (PatientState is unaffected).
      var manualAtCol = apptSheet.getRange(2, INSURANCE_CARRIER_MANUAL_AT_COL, apptSheet.getLastRow() - 1, 1).getValues();
      apptData.forEach(function (row, i) {
        var patNameNorm = _normName(String(row[COL_APPT_PAT_IDX] || ''));
        if (!patNameNorm) return;

        var tebraData = tebraPatientMap[patNameNorm];
        if (!tebraData) return;

        var rowNum = i + 2;
        var existingSt = String(row[COL_APPT_ST_IDX] || '').trim();
        var existingIns = String(row[COL_APPT_INS_IDX] || '').trim();
        var manuallySet = String((manualAtCol[i] && manualAtCol[i][0]) || '').trim();
        var anyUpdate = false;

        if (tebraData.state && (forceOverwrite || !existingSt)) {
          apptSheet.getRange(rowNum, COL_APPT_STATE).setValue(tebraData.state);
          anyUpdate = true;
        }
        if (tebraData.insurance && !manuallySet && (forceOverwrite || !existingIns)) {
          apptSheet.getRange(rowNum, COL_APPT_INS).setValue(tebraData.insurance);
          anyUpdate = true;
        }
        if (anyUpdate) appointmentsUpdated++;
      });
    }

    SpreadsheetApp.flush();
    _audit(ss, 'PATIENT_DATA_SYNC',
      'Patients tab updated: ' + patientsUpdated +
      ', Appointments back-filled: ' + appointmentsUpdated +
      (forceOverwrite ? ' (force overwrite)' : ' (blanks only)'));

    Logger.log('✅  syncPatientStates: ' + patientsUpdated + ' Patients rows, ' +
      appointmentsUpdated + ' Appointment rows updated.');

    return JSON.stringify({
      patientsUpdated: patientsUpdated,
      appointmentsUpdated: appointmentsUpdated,
    });

  } catch (e) {
    Logger.log('syncPatientStates error: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * On-demand sync — fills only blank PatientState values.
 * Run from Apps Script editor or trigger manually.
 */
function runSyncPatientStates() {
  Logger.log('=== Syncing PatientState from Tebra (blanks only) ===');
  var result = JSON.parse(syncPatientStates(null, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

/**
 * Force-overwrites ALL PatientState values with fresh Tebra data.
 * Useful after patients move to a different state.
 */
function runSyncPatientStatesForce() {
  Logger.log('=== Force-syncing PatientState from Tebra (overwriting all) ===');
  var result = JSON.parse(syncPatientStates(null, true));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

/**
 * DIAGNOSTIC — Run from Apps Script editor to verify GetAllPatients is
 * returning state, insurance, and provider data correctly.
 * Logs the first 10 patients with a summary of what was found.
 *
 * Check View → Logs after running.
 */
function testTebraGetPatients() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  Logger.log('=== testTebraGetPatients (GetAllPatients) ===');
  try {
    var patientMap = _fetchTebraPatientStates(c);
    var entries = Object.keys(patientMap);
    Logger.log('Total patients returned: ' + entries.length);
    Logger.log('');
    Logger.log('First 10 entries (name → state | insurance | provider):');
    entries.slice(0, 10).forEach(function (name) {
      var d = patientMap[name];
      Logger.log('  "' + name + '" →  ' +
        'state=' + (d.state || '(blank)') + '  |  ' +
        'ins=' + (d.insurance || '(blank)') + '  |  ' +
        'prov=' + (d.providerName || '(blank)'));
    });

    if (entries.length === 0) {
      Logger.log('');
      Logger.log('⚠️  Zero patients returned. Run testTebraGetPatientsRaw() for raw XML.');
    }
  } catch (e) {
    Logger.log('❌  Error: ' + e.message);
    Logger.log(e.stack || '');
  }
  Logger.log('=== End ===');
}

/**
 * DIAGNOSTIC — dumps the raw GetAllPatients XML response so you can
 * confirm the exact element/field names Tebra uses for this account.
 *
 * Run from Apps Script editor → View → Logs after running.
 * Share the output (especially the first <PatientData> block) to confirm
 * the correct element names for State, Insurance, and Provider fields.
 */
function testTebraGetPatientsRaw() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  // ── Use GetAllPatients with all fields we care about ─────────────────────
  // Field names match the SoapUI test — these are PascalCase and case-sensitive.
  var bodyXml =
    '<ns:GetAllPatients><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:FirstName>true</ns:FirstName>' +
    '<ns:LastName>true</ns:LastName>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:State>true</ns:State>' +
    '<ns:PrimaryInsurancePolicyCompanyName>true</ns:PrimaryInsurancePolicyCompanyName>' +
    '<ns:DefaultRenderingProviderFullName>true</ns:DefaultRenderingProviderFullName>' +
    '<ns:DefaultRenderingProviderId>true</ns:DefaultRenderingProviderId>' +
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:BatchSize>1000</ns:BatchSize>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAllPatients>';

  try {
    var text = _tebraPost('GetAllPatients', bodyXml);
    Logger.log('=== Raw GetAllPatients response ===');
    Logger.log('Total response length: ' + text.length + ' chars');
    Logger.log('');

    // Show the full header/wrapper structure (first 800 chars)
    Logger.log('--- Response start (first 800 chars) ---');
    Logger.log(text.substr(0, 800));

    // Find and show the FIRST patient record so we can verify element names
    var firstPatStart = text.indexOf('<PatientData');
    if (firstPatStart === -1) firstPatStart = text.indexOf('<Patient ');
    if (firstPatStart === -1) firstPatStart = text.indexOf('<Patient>');
    // PatientBatchData — confirmed 2026-08-26 as this account's real container
    // name via this same diagnostic's raw-response fallback below; neither of
    // the two above matched it. Checked last, same order as the fallback
    // chain in _fetchTebraPatientStates().
    if (firstPatStart === -1) firstPatStart = text.indexOf('<PatientBatchData');

    if (firstPatStart !== -1) {
      Logger.log('');
      Logger.log('--- First patient element (up to 1500 chars from that point) ---');
      Logger.log(text.substr(firstPatStart, 1500));
    } else {
      Logger.log('');
      Logger.log('⚠️  No <PatientData> or <Patient> element found in response.');
      Logger.log('Full response (first 5000 chars):');
      Logger.log(text.substr(0, 5000));
    }
  } catch (e) {
    Logger.log('❌  ' + e.message);
    Logger.log(e.stack || '');
  }
  Logger.log('=== End diagnostic ===');
}



// ════════════════════════════════════════════════════════════════════════════
// BULK PAYMENT IMPORT
// Called by the CRB Biller Window → "📥 Import Payments" panel.
// ════════════════════════════════════════════════════════════════════════════

function bulkImportPayments(rowsJson) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet) return JSON.stringify({ error: 'Appointments sheet not found' });

    var importRows = JSON.parse(rowsJson);
    if (!Array.isArray(importRows) || importRows.length === 0)
      return JSON.stringify({ matched: [], unmatched: [], total: 0 });

    var IDX_PROV_ID = APPT_COLS.indexOf('ProvID');
    var IDX_DATE = APPT_COLS.indexOf('Date');
    var IDX_APPT_ID = APPT_COLS.indexOf('ApptID');
    var IDX_PATIENT = APPT_COLS.indexOf('Patient');
    var IDX_STATUS = APPT_COLS.indexOf('ClaimStatus');
    var IDX_PAID_AMT = APPT_COLS.indexOf('ClaimPaidAmount');
    var COL_STATUS = IDX_STATUS + 1;
    var COL_PAID_AMT = IDX_PAID_AMT + 1;

    // Headway may use legal names that differ from CRB provID (e.g. Katherine → katie)
    var provMap = {
      jodene: 'jodene',
      katherine: 'katie',   // Headway full name
      katie: 'katie',
      lori: 'lori',
    };
    var staffSheet = ss.getSheetByName(TAB_STAFF);
    if (staffSheet && staffSheet.getLastRow() > 1) {
      staffSheet.getDataRange().getValues().slice(1).forEach(function (r) {
        var provID = String(r[2] || '').toLowerCase().trim();
        var firstName = String(r[3] || '').trim().split(' ')[0].toLowerCase();
        if (provID && firstName) { provMap[firstName] = provID; provMap[provID] = provID; }
      });
    }

    function _pad2(n) { return n < 10 ? '0' + n : String(n); }
    function normDate(val) {
      if (!val) return '';
      var s = String(val).trim();
      // Already ISO YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      // 4-digit year: M/D/YYYY
      var p4 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (p4) return p4[3] + '-' + _pad2(Number(p4[1])) + '-' + _pad2(Number(p4[2]));
      // 2-digit year: M/D/YY — assume 2000s (Headway export format)
      var p2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      if (p2) return '20' + p2[3] + '-' + _pad2(Number(p2[1])) + '-' + _pad2(Number(p2[2]));
      return s;
    }
    // Normalize patient name: lowercase, collapse spaces, strip punctuation
    function normPat(s) {
      return String(s || '').toLowerCase()
        .replace(/['\-\.]/g, '')   // remove apostrophes, hyphens, periods (O'Brien → obrien)
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Token-based fuzzy match: all words of the shorter name must appear in the longer
    function nameTokenMatch(a, b) {
      var ta = a.split(' ').filter(Boolean);
      var tb = b.split(' ').filter(Boolean);
      var shorter = ta.length <= tb.length ? ta : tb;
      var longer = ta.length <= tb.length ? tb : ta;
      return shorter.every(function (tok) { return longer.indexOf(tok) >= 0; });
    }

    function normProvId(name) {
      var first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
      return provMap[first] || first;
    }

    var allValues = sheet.getDataRange().getValues();
    var matched = [], unmatched = [];

    importRows.forEach(function (row) {
      var targetDate = normDate(row.date || row['APPOINTMENT DATE'] || '');
      var targetProv = normProvId(row.providerName || row['PROVIDER NAME'] || '');
      var targetPat = normPat(row.patientName || row['PATIENT NAME'] || '');
      var payAmt = String(row.paymentAmount || row['PAYMENT AMOUNT'] || '').trim();

      if (!targetDate || !targetProv || !targetPat || !payAmt) {
        unmatched.push({ row: row, reason: 'Missing required field' });
        return;
      }

      // ── Pass 1: exact normalized name match ────────────────────────────
      // Use _fmtDate() to handle sheet cells that store JavaScript Date objects
      // (String(dateObj) gives "Thu May 27 2026 00:00:00 GMT-0400", not "2026-05-27")
      var foundIdx = -1;
      var sameDateProv = [];
      for (var i = 1; i < allValues.length; i++) {
        var r = allValues[i];
        var rDate = _fmtDate(r[IDX_DATE]);   // ← correctly handles Date objects
        var rProv = String(r[IDX_PROV_ID] || '').toLowerCase().trim();
        if (rDate !== targetDate || rProv !== targetProv) continue;
        sameDateProv.push(normPat(String(r[IDX_PATIENT] || '')));
        if (normPat(String(r[IDX_PATIENT] || '')) === targetPat) {
          foundIdx = i; break;
        }
      }

      // ── Pass 2: token-based fuzzy match (handles middle names, ALL CAPS) ─
      if (foundIdx < 0) {
        for (var j = 1; j < allValues.length; j++) {
          var r2 = allValues[j];
          var r2Date = _fmtDate(r2[IDX_DATE]);   // ← same fix here
          var r2Prov = String(r2[IDX_PROV_ID] || '').toLowerCase().trim();
          if (r2Date !== targetDate || r2Prov !== targetProv) continue;
          var r2Pat = normPat(String(r2[IDX_PATIENT] || ''));
          if (nameTokenMatch(targetPat, r2Pat)) {
            foundIdx = j; break;
          }
        }
      }

      if (foundIdx < 0) {
        var hint = sameDateProv.length > 0
          ? 'CRB names for this date: ' + sameDateProv.slice(0, 5).join(' | ')
          : 'No appointments found in CRB for this date/provider';
        unmatched.push({ row: row, reason: 'Name mismatch. ' + hint });
        return;
      }

      var sheetRow = foundIdx + 1;
      sheet.getRange(sheetRow, COL_PAID_AMT).setNumberFormat('@').setValue(payAmt);
      sheet.getRange(sheetRow, COL_STATUS).setValue('Paid');
      allValues[foundIdx][IDX_PAID_AMT] = payAmt;
      allValues[foundIdx][IDX_STATUS] = 'Paid';

      matched.push({
        apptId: String(allValues[foundIdx][IDX_APPT_ID] || ''),
        date: row.date || row['APPOINTMENT DATE'] || '',
        provider: row.providerName || row['PROVIDER NAME'] || '',
        patient: row.patientName || row['PATIENT NAME'] || '',
        amount: payAmt,
      });
    });

    SpreadsheetApp.flush();
    return JSON.stringify({ matched: matched, unmatched: unmatched, total: importRows.length });

  } catch (e) {
    Logger.log('bulkImportPayments error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * SAFE TEST — confirms PatientID is a valid Fields entry for GetAppointments
 * before adding it to the production _fetchTebraAppointments request. This
 * codebase already hit a case (ServiceLocationName/ID) where requesting an
 * invalid field made Tebra silently return ZERO appointments instead of an
 * error — so this is tested in isolation, never assumed. No sheet touched.
 */
function testTebraAppointmentsWithPatientID() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  var end = new Date();
  var start = new Date();
  start.setDate(start.getDate() - 2);
  var tz = Session.getScriptTimeZone();
  var startTebra = _tebraDateFmt(_parseYMD(Utilities.formatDate(start, tz, 'yyyy-MM-dd')));
  var endTebra = _tebraDateFmt(_parseYMD(Utilities.formatDate(end, tz, 'yyyy-MM-dd')));

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
    _tebraHeader(c) +
    '<ns:Fields>' +
    '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
    '<ns:ID>true</ns:ID>' +
    '<ns:PatientCaseID>true</ns:PatientCaseID>' +
    '<ns:PatientCaseName>true</ns:PatientCaseName>' +
    '<ns:PatientFullName>true</ns:PatientFullName>' +
    '<ns:PatientID>true</ns:PatientID>' +
    '<ns:ResourceID1>true</ns:ResourceID1>' +
    '<ns:ResourceName1>true</ns:ResourceName1>' +
    '<ns:StartDate>true</ns:StartDate>' +
    '</ns:Fields>' +
    '<ns:Filter>' +
    '<ns:StartDate>' + startTebra + '</ns:StartDate>' +
    '<ns:EndDate>' + endTebra + '</ns:EndDate>' +
    '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  Logger.log('=== Testing GetAppointments with PatientID field added ===');
  try {
    var text = _tebraPost('GetAppointments', bodyXml);
    var doc = XmlService.parse(text);
    var root = doc.getRootElement();
    var apptEls = [];
    _findXmlElements(root, 'AppointmentData', apptEls);

    Logger.log('Appointments returned: ' + apptEls.length);
    if (apptEls.length === 0) {
      Logger.log('⚠️  ZERO results — PatientID is likely NOT a valid Field here. Do NOT add it to production. Raw response:');
      Logger.log(text.substr(0, 1500));
    } else {
      var samplePid = _findFirstXml(apptEls[0], 'PatientID');
      Logger.log('Sample PatientID from first result: ' + (samplePid || '[blank]'));
      Logger.log(samplePid
        ? '✅  Valid and populated — safe to add to production Fields list.'
        : '⚠️  Appointments came back fine, but PatientID itself is blank — something more specific going on, don\'t assume safe yet.');
    }
  } catch (e) {
    Logger.log('❌  ' + e.message);
  }
  Logger.log('=== End test ===');
}
