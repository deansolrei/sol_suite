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
const TAB_APPT          = 'Appointments';
const TAB_PATIENT       = 'Patients';
const TAB_AUDIT         = 'Audit Log';
const TAB_STAFF         = 'Staff';
const TAB_RATE_ANALYSIS      = 'Rate Analysis';
const TAB_RATE_ANALYSIS_PROV = 'Rate Analysis - By Provider';

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
  'ClaimSubmittedDate', 'ClaimID', 'ClaimStatus', 'ClaimStatusNotes',
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
];

const STAFF_COLS = ['Email', 'Role', 'ProvID', 'DisplayName'];

const STAFF_SEED = [
  ['jodene@solreibehavioralhealth.com',    'provider',  'jodene',   'Jodene'],
  ['katie@solreibehavioralhealth.com',     'provider',  'katie',    'Katie'],
  ['megan@solreibehavioralhealth.com',     'provider',  'megan',    'Megan'],
  ['lori@solreibehavioralhealth.com',      'provider',  'lori',     'Lori'],
  ['jeloah@solreibehavioralhealth.com',    'assistant', '*',        'Jeloah'],
  ['jemaica@solreibehavioralhealth.com',   'assistant', '*',        'Jemaica'],
  ['marianne@solreibehavioralhealth.com',  'assistant', '*',        'Marianne'],
  ['cassandra@solreibehavioralhealth.com', 'assistant', '*',        'Cassandra'],
  ['dean@solreibehavioralhealth.com',      'biller',    '*',        'Dean'],
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
   LOGO
════════════════════════════════════════════════════════════════ */
function getLogoBase64() {
  try {
    const file  = DriveApp.getFileById(LOGO_FILE_ID);
    const blob  = file.getBlob();
    const mime  = blob.getContentType() || 'image/png';
    const b64   = Utilities.base64Encode(blob.getBytes());
    return 'data:' + mime + ';base64,' + b64;
  } catch (e) {
    Logger.log('getLogoBase64 error: ' + e.message);
    return '';
  }
}


/* ════════════════════════════════════════════════════════════════
   READ — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function getAppointments(prov, date) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const deny  = _checkProvAccess(ss, prov);
    if (deny) return deny;
    const sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    const rows  = sheet.getDataRange().getValues().slice(1);

    // ── Day's appointments (raw, before unsigned override) ──────────
    const dayAppts = rows
      .filter(r => String(r[0]) === prov && _fmtDate(r[1]) === date)
      .map(rowToAppt);

    if (dayAppts.length === 0) return JSON.stringify([]);

    // ── Dynamically compute unsigned[] for each patient ─────────────
    // Column V (UnsignedDates) is no longer read — Signed + TebraStatus are
    // the only source of truth (clinic standard set 2026-07-24). We scan
    // EVERY row for each patient present today and rebuild unsigned[] fresh
    // from actual Signed=FALSE rows whose visit actually occurred.
    //
    // Rules:
    //   • Only rows where Signed != TRUE (i.e. FALSE or blank)
    //   • Only rows where the visit actually occurred — TebraStatus is
    //     "Confirmed" or "Checked Out" (_visitOccurred). "Scheduled" and
    //     void statuses (No-show/Rescheduled/Cancelled) never contribute.
    //   • Only dates strictly before 'date' (today's slot is excluded —
    //     it is recorded as unsigned in the sheet but NOT shown in the
    //     banner; filterDisplayUnsigned on the front-end handles this
    //     but we keep the back-end consistent too)
    //   • Result is de-duplicated and stored in MM/DD/YY format

    // Collect normalised patient names present today
    const patientSet = {};
    dayAppts.forEach(function(a) {
      patientSet[_normName(a.patient)] = true;
    });

    // Build: normName → Set<MM/DD/YY> of unsigned dates
    const patientUnsigned = {};  // key: normName, value: Set of date strings

    rows.forEach(function(r) {
      var rProv    = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      if (rProv !== prov) return;                          // different provider
      if (!patientSet[rPatNorm]) return;                   // not in today's list
      if (!_visitOccurred(String(r[34] || ''))) return;     // no completed visit — never unsigned

      var signed = r[25];
      var isSigned = (signed === true || String(signed).toUpperCase() === 'TRUE');
      if (isSigned) return;                                // already signed

      var rDate = _fmtDate(r[1]);  // YYYY-MM-DD
      if (!rDate || rDate >= date) return;                 // future or same day — skip

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
    dayAppts.forEach(function(a) {
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
    const ss   = SpreadsheetApp.getActiveSpreadsheet();
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
    const weekEnd   = dates[dates.length - 1];

    // Collect all patients in this week's appointments (for this provider)
    const patientSet = {};
    dates.forEach(function(ds) {
      (result[prov + '||' + ds] || []).forEach(function(a) {
        patientSet[_normName(a.patient)] = true;
      });
    });

    // Build normName → Set<MM/DD/YY> of unsigned dates strictly before weekEnd.
    // Only rows where the visit actually occurred (_visitOccurred — Confirmed
    // or Checked Out) count; "Scheduled" and void statuses never contribute.
    const patientUnsigned = {};
    allRows.forEach(function(r) {
      var rProv    = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      if (rProv !== prov) return;
      if (!patientSet[rPatNorm]) return;
      if (!_visitOccurred(String(r[34] || ''))) return;

      var signed = r[25];
      var isSigned = (signed === true || String(signed).toUpperCase() === 'TRUE');
      if (isSigned) return;

      var rDate = _fmtDate(r[1]);
      if (!rDate) return;
      // Include unsigned dates up through the last day of the week
      // (each day's slot filters its own date via filterDisplayUnsigned on FE)
      if (rDate > weekEnd) return;

      var dateStr = _toUnsignedDateStr(rDate);
      if (!dateStr) return;

      if (!patientUnsigned[rPatNorm]) patientUnsigned[rPatNorm] = {};
      patientUnsigned[rPatNorm][dateStr] = true;
    });

    // Override unsigned[] on all week appointments — freshly computed only,
    // no merge with column V (inert now; Signed + TebraStatus are the source
    // of truth).
    dates.forEach(function(ds) {
      (result[prov + '||' + ds] || []).forEach(function(a) {
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
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
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
    dates.forEach(function(ds) { dateSet[ds] = true; });

    var result = {};
    dates.forEach(function(ds) { result[ds] = []; });

    var allRows = sheet.getDataRange().getValues().slice(1);
    var weekEnd  = dates[dates.length - 1];

    allRows
      .filter(function(r) { return !!dateSet[_fmtDate(r[1])]; })
      .forEach(function(r) {
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
    dates.forEach(function(ds) {
      (result[ds] || []).forEach(function(a) {
        var key = (a.provID || '') + '||' + _normName(a.patient);
        patientSet[key] = true;
      });
    });

    // Build provID+normName → Set<MM/DD/YY> of unsigned dates. Only rows
    // where the visit actually occurred (_visitOccurred — Confirmed or
    // Checked Out) count; "Scheduled" and void statuses never contribute.
    var patientUnsigned = {};
    allRows.forEach(function(r) {
      var rProv    = String(r[0] || '');
      var rPatNorm = _normName(String(r[4] || ''));
      var key      = rProv + '||' + rPatNorm;
      if (!patientSet[key]) return;
      if (!_visitOccurred(String(r[34] || ''))) return;

      var signed   = r[25];
      var isSigned = (signed === true || String(signed).toUpperCase() === 'TRUE');
      if (isSigned) return;

      var rDate = _fmtDate(r[1]);
      if (!rDate || rDate > weekEnd) return;

      var dateStr = _toUnsignedDateStr(rDate);
      if (!dateStr) return;

      if (!patientUnsigned[key]) patientUnsigned[key] = {};
      patientUnsigned[key][dateStr] = true;
    });

    // Override unsigned[] on all week appointments — freshly computed only,
    // no merge with column V (inert now; Signed + TebraStatus are the source
    // of truth).
    dates.forEach(function(ds) {
      (result[ds] || []).forEach(function(a) {
        var key      = (a.provID || '') + '||' + _normName(a.patient);
        a.unsigned   = patientUnsigned[key] ? Object.keys(patientUnsigned[key]) : [];
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

    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);

    var today  = _fmtDate(new Date());
    var values = sheet.getDataRange().getValues().slice(1);
    var matches = [];

    values.forEach(function(r) {
      var patient = String(r[4] || '').trim();
      if (patient.toLowerCase().indexOf(q) === -1) return;
      var date = _fmtDate(r[1]);
      if (!date) return;
      matches.push({
        provID:  String(r[0] || ''),
        date:    date,
        time:    _fmtTime(r[3]),
        patient: patient,
        method:  String(r[5]  || ''),
        status:  String(r[24] || 'pending'),
        out:     r[25] === true || r[25] === 'TRUE',
        billing: String(r[23] || 'pending'),
      });
    });

    matches.sort(function(a, b) {
      var aUp = a.date >= today, bUp = b.date >= today;
      if (aUp && !bUp) return -1;
      if (!aUp && bUp) return  1;
      if (aUp)  return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
    });

    return JSON.stringify(matches.slice(0, 60));
  } catch (e) {
    Logger.log('searchPatient error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   WRITE — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function saveAppointment(prov, date, apptJson) {
  try {
    const appt  = JSON.parse(apptJson);
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const deny  = _checkProvAccess(ss, prov);
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

    const TIME_COL     = APPT_COLS.indexOf('Time') + 1;
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
      APPT_COLS.forEach(function(col, i) {
        if (!newHdrs[i]) newHdrs[i] = col;
      });
      hdrRange.setValues([newHdrs]);
    }

    if (targetRow > 0) {
      // ── UPDATE path ──
      // Column V (UnsignedDates) is no longer maintained — Signed + TebraStatus
      // are the only source of truth for "does this row need a signed note"
      // (clinic standard set 2026-07-24; see _visitOccurred). apptToRow() still
      // writes appt.unsigned to col V for the row's own cell, so we explicitly
      // clear it here rather than carry forward whatever the client last loaded
      // — no back-filling other rows, no accumulation, nothing to go stale.
      var apptData = Object.assign({}, appt);   // mutable copy — don't mutate parsed JSON
      apptData.unsigned = [];

      // ── Stamp InsuranceCarrier + PatientState from Patient DB ────────────
      // Always refresh from the source of truth so records stay accurate even
      // when the patient DB is updated after the appointment was created.
      // Priority: Patient DB > existing appointment value > directIns (direct only).
      var patInfo = _lookupPatient(ss, apptData.patient);
      apptData.insuranceCarrier = patInfo.insurance
        || apptData.insuranceCarrier
        || (apptData.method === 'direct' ? apptData.directIns : '')
        || '';
      apptData.patientState = patInfo.patientState || apptData.patientState || '';

      const rowData = apptToRow(apptData, prov, date);

      // ── Preserve Tebra-synced columns that the client may not have ──
      // If the incoming appt has no tebraStatus (e.g. the provider loaded
      // their page before the biller ran a Tebra sync), keep whatever value
      // is already in the sheet so we don't silently overwrite it.
      const TS_IDX = APPT_COLS.indexOf('TebraStatus'); // 0-based
      if (TS_IDX >= 0 && !apptData.tebraStatus) {
        const sheetRow   = values[targetRow - 1];  // values[] was read above
        const sheetTebra = sheetRow && sheetRow.length > TS_IDX
          ? String(sheetRow[TS_IDX] || '') : '';
        if (sheetTebra) rowData[TS_IDX] = sheetTebra;
      }

      sheet.getRange(targetRow, TIME_COL).setNumberFormat('@');
      sheet.getRange(targetRow, UNSIGNED_COL).setNumberFormat('@');
      // Force plain-text format on date fields to prevent Sheets auto-converting
      // ISO strings ('2026-03-16') back to Date objects on next read.
      [36, 40, 44, 48].forEach(function(c) { sheet.getRange(targetRow, c).setNumberFormat('@'); });
      sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
      _audit(ss, 'UPDATE', `${apptData.patient} | ${apptData.time} | ${date} | ${prov}`);
    } else {
      // ── CREATE path ──
      // Column V (UnsignedDates) is no longer maintained. A newly created
      // appointment's own date is never seeded as "unsigned" here — whether
      // it counts is decided dynamically at read time, and only once
      // TebraStatus shows the visit actually happened (Confirmed/Checked
      // Out), never while it's still just "Scheduled" or in the future
      // (clinic standard set 2026-07-24; see _visitOccurred). This is what
      // fixes future-dated appointments showing up as unsigned before
      // they've even happened.
      appt.unsigned = [];

      // ── Stamp InsuranceCarrier + PatientState from Patient DB ────────────
      var patInfoNew = _lookupPatient(ss, appt.patient);
      appt.insuranceCarrier = patInfoNew.insurance
        || (appt.method === 'direct' ? appt.directIns : '')
        || '';
      appt.patientState = patInfoNew.patientState || '';

      // Write the new row.
      const rowData = apptToRow(appt, prov, date);
      const newRow  = sheet.getLastRow() + 1;
      sheet.getRange(newRow, TIME_COL).setNumberFormat('@');
      sheet.getRange(newRow, UNSIGNED_COL).setNumberFormat('@');
      // Force plain-text format on date fields to prevent Sheets auto-converting
      // ISO strings ('2026-03-16') back to Date objects on next read.
      [36, 40, 44, 48].forEach(function(c) { sheet.getRange(newRow, c).setNumberFormat('@'); });
      sheet.getRange(newRow, 1, 1, rowData.length).setValues([rowData]);

      _audit(ss, 'CREATE', `${appt.patient} | ${appt.time} | ${date} | ${prov}`);
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
    return `${slash[0].trim().padStart(2,'0')}/${slash[1].trim().padStart(2,'0')}/${yr.padStart(2,'0')}`;
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

    var COL_ID     = APPT_COLS.indexOf('ApptID') + 1;  // C = 3
    var COL_SIGNED = APPT_COLS.indexOf('Signed') + 1;  // Z = 26

    var data = sheet.getDataRange().getValues();
    var idN  = String(apptId || '').trim();

    var signed = 0;
    for (var i = 1; i < data.length; i++) {
      var rowId = String(data[i][COL_ID - 1] || '').trim();
      if (rowId !== idN) continue;
      sheet.getRange(i + 1, COL_SIGNED).setValue(true);
      signed++;
      Logger.log('signNoteAndClearUnsigned: row ' + (i + 1) + ' marked Signed=TRUE ' +
                 '(ApptID=' + idN + ', patient="' + patient + '", date=' + signedISO + ')');
      break; // ApptID is unique — no need to keep scanning once found
    }

    SpreadsheetApp.flush();

    _audit(ss, 'SIGN', 'Patient: ' + patient + ' | Date: ' + signedISO + ' | Signed: ' + signed);

    return JSON.stringify({ ok: true, signed: signed, cleared: 0, affected: [] });
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
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: true, cleared: 0 });

    var email = Session.getActiveUser().getEmail();
    var staff = _getStaffRecord(ss, email);
    if (!staff || staff.role === 'unknown') {
      return JSON.stringify({ ok: false, error: 'Access denied.' });
    }

    var ID_IDX       = APPT_COLS.indexOf('ApptID');         // 0-based
    var DATE_IDX     = APPT_COLS.indexOf('Date');           // 0-based
    var PATIENT_IDX  = APPT_COLS.indexOf('Patient');        // 0-based
    var UNSIGNED_IDX = APPT_COLS.indexOf('UnsignedDates');  // 0-based
    var COL_UNSIGNED = UNSIGNED_IDX + 1;                    // 1-based for getRange

    var idN       = String(apptId  || '').trim();
    var targetISO = _normalizeDateStr(dateStr);
    if (!idN || !targetISO) {
      return JSON.stringify({ ok: false, error: 'apptId and dateStr are required.' });
    }

    var values   = sheet.getDataRange().getValues();
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
        ok:    false,
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
      var dates    = rawCell.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
      var filtered = dates.filter(function(d) { return _normalizeDateStr(d) !== targetISO; });
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
  return s === 'no show'      || s === 'noshow'           || s === 'no-show'         ||
         s === 'rescheduled'  || s === 'needsreschedule'  || s === 'needs reschedule' ||
         s === 'cancelled'    || s === 'canceled'         ||
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
/** True only for statuses that represent an actual completed visit — the
 *  only two states a "needs a signed note" evaluation should ever apply to. */
function _visitOccurred(tebraStatus) {
  return _isConfirmedStatus(tebraStatus) || _isCheckedOutStatus(tebraStatus);
}

function getTotalUnsignedCount(prov) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ count: 0 });

    var PROV_IDX   = APPT_COLS.indexOf('ProvID');        // 0  (col A)
    var DATE_IDX   = APPT_COLS.indexOf('Date');          // 1  (col B)
    var SIGNED_IDX = APPT_COLS.indexOf('Signed');        // 25 (col Z)
    var TEBRA_IDX  = APPT_COLS.indexOf('TebraStatus');   // 34 (col AI)

    var tz    = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var rows  = sheet.getDataRange().getValues();
    var count = 0;

    // Placeholder patients are calendar-block entries (personal day holds, room
    // blocks, etc.) and must never count toward unsigned note totals.
    var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file
    var PATIENT_IDX = APPT_COLS.indexOf('Patient');

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];

      // Provider filter
      var rowProv = String(r[PROV_IDX] || '').trim();
      if (prov && rowProv !== String(prov).trim()) continue;

      // Only past appointments (strictly before today — today's notes don't count yet)
      var rowDate = _fmtDate(r[DATE_IDX]);
      if (!rowDate || rowDate >= today) continue;

      // Clinic standard (2026-07-24): only "Confirmed" (visit happened, not yet
      // signed) or "Checked Out" (visit happened, note signed) represent an actual
      // completed visit. "Scheduled" means the visit hasn't happened yet — never
      // needs a note. No-show/Rescheduled/Cancelled are void. Anything else
      // (blank, unrecognized status) is treated the same as "not yet occurred."
      var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
      if (!_visitOccurred(tebraStatus)) continue;

      // Skip placeholder patients (calendar blocks / personal day holds)
      if (PATIENT_IDX >= 0) {
        var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
        if (PLACEHOLDER_NAMES.indexOf(patName) !== -1) continue;
      }

      // Count if the note has NOT been signed
      var signedVal = r[SIGNED_IDX];
      var isSigned  = signedVal === true ||
                      String(signedVal).trim().toUpperCase() === 'TRUE';
      if (!isSigned) count++;
    }

    return JSON.stringify({ count: count });
  } catch (e) {
    Logger.log('getTotalUnsignedCount ERROR: ' + e.message);
    return JSON.stringify({ count: 0, error: e.message });
  }
}

/* ════════════════════════════════════════════════════════════════════
   READ-ONLY AUDIT — auditUnsignedNotes
   ════════════════════════════════════════════════════════════════════
   Diagnoses the "168 outstanding notes vs. ~60 real" discrepancy Dean
   flagged 2026-07-24. NEVER writes to the Appointments or Patients
   tabs — only reads them. Writes a report to a separate new tab
   ("UnsignedNotesAudit"), which is fully cleared and rebuilt each run.
   No other tab, formula, or existing data is touched.

   Replicates getTotalUnsignedCount()'s exact counting rule (provider
   filter if given, date strictly before today, TebraStatus not void,
   patient not a placeholder block, Signed != TRUE) so the audit's
   grand total should match the live "outstanding notes" badge
   exactly. If it doesn't, that mismatch is itself a useful signal.

   For every row that counts, buckets it by:
     • age         — days between the appointment date and today
     • everWorked  — true if Intake / InsVerified / Autopay /
                      NoteStatus / CPTCodes has ANY value — a proxy
                      for "someone in SolBoard actually opened this
                      row" vs. "pure Tebra-sync artifact nobody ever
                      touched"
     • noteStatus  — raw NoteStatus value (blank / not_started /
                      in_progress / ready)
     • tebraStatus — raw TebraStatus value, to catch any cancellation
                      or reschedule wording _isVoidStatus doesn't
                      currently recognize
     • duplicate   — same patient + same date counted on more than one
                      row (possible reschedule artifact — Tebra sync
                      creating a new row without resolving the old one)

   HOW TO RUN:
     1. Apps Script editor → function dropdown → auditUnsignedNotes
     2. Click ▶ Run
     3. Open the "UnsignedNotesAudit" tab on the spreadsheet.
════════════════════════════════════════════════════════════════════ */
function auditUnsignedNotes() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('No appointment data found.');
    return;
  }

  var PROV_IDX     = APPT_COLS.indexOf('ProvID');
  var DATE_IDX     = APPT_COLS.indexOf('Date');
  var APPTID_IDX   = APPT_COLS.indexOf('ApptID');
  var PATIENT_IDX  = APPT_COLS.indexOf('Patient');
  var INTAKE_IDX   = APPT_COLS.indexOf('Intake');
  var INSVER_IDX   = APPT_COLS.indexOf('InsVerified');
  var AUTOPAY_IDX  = APPT_COLS.indexOf('Autopay');
  var CPT_IDX      = APPT_COLS.indexOf('CPTCodes');
  var SIGNED_IDX   = APPT_COLS.indexOf('Signed');
  var TEBRA_IDX    = APPT_COLS.indexOf('TebraStatus');
  var NOTESTAT_IDX = APPT_COLS.indexOf('NoteStatus');

  // Same placeholder list as getTotalUnsignedCount — calendar blocks /
  // personal-day holds, never real patients.
  var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var rows  = sheet.getDataRange().getValues();

  // ── Pass 1: collect every row that counts, exactly like getTotalUnsignedCount ──
  var counted = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];

    var rowProv = String(r[PROV_IDX] || '').trim();
    var rowDate = _fmtDate(r[DATE_IDX]);
    if (!rowDate || rowDate >= today) continue;

    var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
    if (_isVoidStatus(tebraStatus)) continue;

    var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
    if (PLACEHOLDER_NAMES.indexOf(patName) !== -1) continue;

    var signedVal = r[SIGNED_IDX];
    var isSigned  = signedVal === true || String(signedVal).trim().toUpperCase() === 'TRUE';
    if (isSigned) continue;

    var ageDays = Math.floor((new Date(today) - new Date(rowDate)) / 86400000);
    var everWorked = !!(String(r[INTAKE_IDX]   || '').trim() ||
                         String(r[INSVER_IDX]  || '').trim() ||
                         String(r[AUTOPAY_IDX] || '').trim() ||
                         String(r[NOTESTAT_IDX] || '').trim() ||
                         String(r[CPT_IDX]     || '').trim());

    counted.push({
      row:         i + 1,
      prov:        rowProv,
      date:        rowDate,
      apptId:      String(r[APPTID_IDX] || ''),
      patient:     String(r[PATIENT_IDX] || '').trim(),
      ageDays:     ageDays,
      everWorked:  everWorked,
      noteStatus:  String(r[NOTESTAT_IDX] || '').trim() || '(blank)',
      tebraStatus: tebraStatus.trim() || '(blank)',
    });
  }

  // ── Pass 2: aggregate ──
  var byProv         = {};
  var ageBuckets      = { '0-30 days': 0, '31-90 days': 0, '91-180 days': 0, '181-365 days': 0, '365+ days': 0 };
  var workedSplit     = { 'Ever touched in SolBoard': 0, 'Never touched (pure sync artifact?)': 0 };
  var noteStatusFreq  = {};
  var tebraStatusFreq = {};
  var dupKeys         = {};   // "normName|date" -> array of counted entries

  counted.forEach(function(c) {
    byProv[c.prov] = (byProv[c.prov] || 0) + 1;

    if (c.ageDays <= 30) ageBuckets['0-30 days']++;
    else if (c.ageDays <= 90) ageBuckets['31-90 days']++;
    else if (c.ageDays <= 180) ageBuckets['91-180 days']++;
    else if (c.ageDays <= 365) ageBuckets['181-365 days']++;
    else ageBuckets['365+ days']++;

    workedSplit[c.everWorked ? 'Ever touched in SolBoard' : 'Never touched (pure sync artifact?)']++;

    noteStatusFreq[c.noteStatus]   = (noteStatusFreq[c.noteStatus]   || 0) + 1;
    tebraStatusFreq[c.tebraStatus] = (tebraStatusFreq[c.tebraStatus] || 0) + 1;

    var dk = _normName(c.patient) + '|' + c.date;
    if (!dupKeys[dk]) dupKeys[dk] = [];
    dupKeys[dk].push(c);
  });

  var dupGroups = Object.keys(dupKeys)
    .map(function(k) { return dupKeys[k]; })
    .filter(function(arr) { return arr.length > 1; })
    .sort(function(a, b) { return b.length - a.length; });

  // ── Write report to a fresh 'UnsignedNotesAudit' tab ──
  var reportName = 'UnsignedNotesAudit';
  var existing = ss.getSheetByName(reportName);
  if (existing) ss.deleteSheet(existing);
  var report = ss.insertSheet(reportName);
  report.setTabColor('#DC2626');

  var out = [];
  var boldRows = [];   // row indices (0-based into out[]) to bold after writing

  function pushHeader(text) {
    boldRows.push(out.length);
    out.push([text]);
  }

  pushHeader('Unsigned Notes Audit — generated ' + new Date().toLocaleString());
  out.push(['Read-only: this report never modifies the Appointments or Patients tabs.']);
  out.push([]);
  pushHeader('GRAND TOTAL — should match the live "outstanding notes" badge exactly');
  out.push(['Total counted rows', counted.length]);
  out.push([]);

  pushHeader('By Provider');
  Object.keys(byProv).sort().forEach(function(p) { out.push([p, byProv[p]]); });
  out.push([]);

  pushHeader('By Age of Appointment Date');
  Object.keys(ageBuckets).forEach(function(b) { out.push([b, ageBuckets[b]]); });
  out.push([]);

  pushHeader('Ever Worked in SolBoard? (Intake/InsVerified/Autopay/NoteStatus/CPTCodes all blank = likely a pure sync artifact nobody opened)');
  Object.keys(workedSplit).forEach(function(k) { out.push([k, workedSplit[k]]); });
  out.push([]);

  pushHeader('NoteStatus Value Distribution');
  Object.keys(noteStatusFreq).sort().forEach(function(k) { out.push([k, noteStatusFreq[k]]); });
  out.push([]);

  pushHeader('TebraStatus Value Distribution (check for cancel/reschedule wording _isVoidStatus might be missing)');
  Object.keys(tebraStatusFreq).sort().forEach(function(k) { out.push([k, tebraStatusFreq[k]]); });
  out.push([]);

  pushHeader('Possible Duplicate Rows (same patient + same date, counted more than once — possible reschedule artifact)');
  out.push(['Duplicate groups found', dupGroups.length]);
  if (dupGroups.length) {
    out.push(['Patient', 'Date', 'ApptID', 'Provider', 'NoteStatus', 'TebraStatus']);
    dupGroups.forEach(function(group) {
      group.forEach(function(c) {
        out.push([c.patient, c.date, c.apptId, c.prov, c.noteStatus, c.tebraStatus]);
      });
      out.push([]);
    });
  }
  out.push([]);

  pushHeader('Oldest 30 Counted Rows (spot-check these by hand)');
  out.push(['Patient', 'Date', 'Age (days)', 'Provider', 'ApptID', 'Ever Worked?', 'NoteStatus', 'TebraStatus']);
  counted
    .slice()
    .sort(function(a, b) { return b.ageDays - a.ageDays; })
    .slice(0, 30)
    .forEach(function(c) {
      out.push([c.patient, c.date, c.ageDays, c.prov, c.apptId, c.everWorked ? 'Yes' : 'No', c.noteStatus, c.tebraStatus]);
    });

  var maxCols = out.reduce(function(m, row) { return Math.max(m, row.length); }, 1);
  out.forEach(function(row) { while (row.length < maxCols) row.push(''); });

  report.getRange(1, 1, out.length, maxCols).setValues(out);
  boldRows.forEach(function(idx) {
    report.getRange(idx + 1, 1, 1, maxCols).setFontWeight('bold').setBackground('#F2EDDB');
  });
  report.getRange(1, 1, 1, maxCols).setFontSize(13);
  report.setFrozenRows(0);
  report.autoResizeColumns(1, maxCols);

  Logger.log('auditUnsignedNotes: done. Grand total = ' + counted.length +
             ' (compare against the live "outstanding notes" badge). See the "UnsignedNotesAudit" tab.');
}

/* ════════════════════════════════════════════════════════════════════
   READ-ONLY AUDIT — auditUnsignedNotesV2
   ════════════════════════════════════════════════════════════════════
   Diagnoses the 291 → 158 gap Dean flagged 2026-07-25, after the
   clinic-standard fix + Tebra Sync auto-reconciliation went live.
   Never writes to Appointments/Patients — only reads. Writes a report
   to a fresh "UnsignedNotesAudit2" tab (cleared and rebuilt each run).

   Replicates getTotalUnsignedCount()'s exact counting rule (provider
   filter if given, date strictly before today, _visitOccurred true,
   patient not a placeholder, Signed != TRUE) so the grand total here
   should match the live "outstanding notes" badge exactly.

   The specific question this answers: is the 158 mostly (a) Confirmed
   rows — a real, current backlog — or (b) Checked Out rows that Tebra
   Sync's auto-reconciliation hasn't reached yet because they fall
   outside the date window of whichever sync last ran? Nightly reaches
   14 days back; Full Sync reaches 90 days back. A Checked-Out row
   older than 90 days needs a dedicated one-time reconciliation pass —
   no sync window will ever touch it.

   HOW TO RUN:
     1. Apps Script editor → function dropdown → auditUnsignedNotesV2
     2. Click ▶ Run
     3. Open the "UnsignedNotesAudit2" tab on the spreadsheet.
════════════════════════════════════════════════════════════════════ */
function auditUnsignedNotesV2() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('No appointment data found.');
    return;
  }

  var PROV_IDX    = APPT_COLS.indexOf('ProvID');
  var DATE_IDX    = APPT_COLS.indexOf('Date');
  var APPTID_IDX  = APPT_COLS.indexOf('ApptID');
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');
  var SIGNED_IDX  = APPT_COLS.indexOf('Signed');
  var TEBRA_IDX   = APPT_COLS.indexOf('TebraStatus');

  var PLACEHOLDER_NAMES = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var rows  = sheet.getDataRange().getValues();

  // ── Pass 1: collect every row that counts, exactly like getTotalUnsignedCount ──
  var counted = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];

    var rowProv = String(r[PROV_IDX] || '').trim();
    var rowDate = _fmtDate(r[DATE_IDX]);
    if (!rowDate || rowDate >= today) continue;

    var tebraStatus = TEBRA_IDX >= 0 ? String(r[TEBRA_IDX] || '') : '';
    if (!_visitOccurred(tebraStatus)) continue;

    var patName = String(r[PATIENT_IDX] || '').trim().toUpperCase();
    if (PLACEHOLDER_NAMES.indexOf(patName) !== -1) continue;

    var signedVal = r[SIGNED_IDX];
    var isSigned  = signedVal === true || String(signedVal).trim().toUpperCase() === 'TRUE';
    if (isSigned) continue;

    var ageDays = Math.floor((new Date(today) - new Date(rowDate)) / 86400000);
    var statusBucket = _isCheckedOutStatus(tebraStatus) ? 'Checked Out' :
                        _isConfirmedStatus(tebraStatus)  ? 'Confirmed'   : 'Other';
    var syncReach = ageDays <= 14  ? 'Within nightly (≤14d)' :
                     ageDays <= 90 ? 'Within Full Sync only (15-90d)' :
                                      'Beyond Full Sync (90d+)';

    counted.push({
      row:          i + 1,
      prov:         rowProv,
      date:         rowDate,
      apptId:       String(r[APPTID_IDX] || ''),
      patient:      String(r[PATIENT_IDX] || '').trim(),
      ageDays:      ageDays,
      tebraStatus:  tebraStatus.trim() || '(blank)',
      statusBucket: statusBucket,
      syncReach:    syncReach,
    });
  }

  // ── Pass 2: aggregate ──
  var byProv           = {};
  var byStatusBucket    = { 'Confirmed': 0, 'Checked Out': 0, 'Other': 0 };
  var byProvAndStatus   = {}; // "prov|statusBucket" -> count
  var byStatusAndReach  = {}; // "statusBucket|syncReach" -> count

  counted.forEach(function(c) {
    byProv[c.prov] = (byProv[c.prov] || 0) + 1;
    byStatusBucket[c.statusBucket] = (byStatusBucket[c.statusBucket] || 0) + 1;

    var psk = c.prov + '|' + c.statusBucket;
    byProvAndStatus[psk] = (byProvAndStatus[psk] || 0) + 1;

    var srk = c.statusBucket + '|' + c.syncReach;
    byStatusAndReach[srk] = (byStatusAndReach[srk] || 0) + 1;
  });

  // ── Write report to a fresh 'UnsignedNotesAudit2' tab ──
  var reportName = 'UnsignedNotesAudit2';
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

  pushHeader('Unsigned Notes Audit V2 — generated ' + new Date().toLocaleString());
  out.push(['Read-only: this report never modifies the Appointments or Patients tabs.']);
  out.push([]);
  pushHeader('GRAND TOTAL — should match the live "outstanding notes" badge exactly');
  out.push(['Total counted rows', counted.length]);
  out.push([]);

  pushHeader('By Provider');
  Object.keys(byProv).sort().forEach(function(p) { out.push([p, byProv[p]]); });
  out.push([]);

  pushHeader('By Status Bucket — Confirmed = real current backlog. Checked Out = should have been auto-signed; if nonzero, auto-reconciliation has not reached these rows yet.');
  Object.keys(byStatusBucket).forEach(function(k) { out.push([k, byStatusBucket[k]]); });
  out.push([]);

  pushHeader('By Provider × Status Bucket');
  out.push(['Provider', 'Status Bucket', 'Count']);
  Object.keys(byProvAndStatus).sort().forEach(function(k) {
    var parts = k.split('|');
    out.push([parts[0], parts[1], byProvAndStatus[k]]);
  });
  out.push([]);

  pushHeader('Checked Out rows by Sync Reach — tells us whether Full Sync (90d back) would fix these, or whether they need a dedicated one-time reconciliation pass regardless of sync window');
  out.push(['Sync Reach', 'Confirmed', 'Checked Out']);
  ['Within nightly (≤14d)', 'Within Full Sync only (15-90d)', 'Beyond Full Sync (90d+)'].forEach(function(reach) {
    out.push([
      reach,
      byStatusAndReach['Confirmed|' + reach] || 0,
      byStatusAndReach['Checked Out|' + reach] || 0,
    ]);
  });
  out.push([]);

  pushHeader('All Checked-Out-but-Unsigned rows (spot-check these — these should be Signed=TRUE)');
  out.push(['Patient', 'Date', 'Age (days)', 'Provider', 'ApptID', 'TebraStatus', 'Sync Reach']);
  counted
    .filter(function(c) { return c.statusBucket === 'Checked Out'; })
    .sort(function(a, b) { return b.ageDays - a.ageDays; })
    .forEach(function(c) {
      out.push([c.patient, c.date, c.ageDays, c.prov, c.apptId, c.tebraStatus, c.syncReach]);
    });

  var maxCols = out.reduce(function(m, row) { return Math.max(m, row.length); }, 1);
  out.forEach(function(row) { while (row.length < maxCols) row.push(''); });

  report.getRange(1, 1, out.length, maxCols).setValues(out);
  boldRows.forEach(function(idx) {
    report.getRange(idx + 1, 1, 1, maxCols).setFontWeight('bold').setBackground('#F2EDDB');
  });
  report.getRange(1, 1, 1, maxCols).setFontSize(13);
  report.setFrozenRows(0);
  report.autoResizeColumns(1, maxCols);

  Logger.log('auditUnsignedNotesV2: done. Grand total = ' + counted.length +
             ' | Confirmed = ' + byStatusBucket['Confirmed'] +
             ' | Checked Out (should be 0!) = ' + byStatusBucket['Checked Out'] +
             ' | Other = ' + byStatusBucket['Other'] +
             '. See the "UnsignedNotesAudit2" tab.');
}

/* ════════════════════════════════════════════════════════════════════
   ONE-TIME MAINTENANCE — reconcileAllCheckedOutSigned
   ════════════════════════════════════════════════════════════════════
   Closes the remaining gap auditUnsignedNotesV2 found 2026-07-25: some
   rows have TebraStatus = Checked Out but Signed != TRUE, because they
   fall outside the date window of whatever Tebra sync last touched
   them (nightly = 14 days back, Full Sync = 90 days back). This scans
   the ENTIRE Appointments sheet directly — no Tebra API call, no date
   window — and applies the exact same rule Tebra Sync's auto-
   reconciliation already applies on every sync (see importFromTebraApi,
   "Auto-reconcile Signed flag" block): Checked Out + Signed != TRUE =>
   Signed = TRUE. Never touches any other column, never unsets Signed.

   Idempotent — safe to run more than once. On a clean sheet it will
   find nothing to update and no-op.

   HOW TO RUN:
     1. Apps Script editor → function dropdown → reconcileAllCheckedOutSigned
     2. Click ▶ Run
     3. Check Logger output (View → Logs) for how many rows were updated.
════════════════════════════════════════════════════════════════════ */
function reconcileAllCheckedOutSigned() {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('reconcileAllCheckedOutSigned: no appointment data found.');
      return JSON.stringify({ ok: true, updated: 0 });
    }

    var COL_SIGNED = APPT_COLS.indexOf('Signed') + 1;       // 1-based
    var COL_TEBRA  = APPT_COLS.indexOf('TebraStatus') + 1;  // 1-based
    if (COL_SIGNED <= 0 || COL_TEBRA <= 0) {
      Logger.log('reconcileAllCheckedOutSigned: Signed or TebraStatus column not found.');
      return JSON.stringify({ ok: false, error: 'Signed or TebraStatus column not found.' });
    }

    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX    = APPT_COLS.indexOf('Date');
    var lastRow     = sheet.getLastRow();
    var readCols    = Math.max(COL_SIGNED, COL_TEBRA);
    var data        = sheet.getRange(2, 1, lastRow - 1, readCols).getValues();

    var updates = []; // { row, patient, date }

    data.forEach(function(r, i) {
      var tebraStatus = String(r[COL_TEBRA - 1] || '');
      if (!_isCheckedOutStatus(tebraStatus)) return;

      var signedVal = r[COL_SIGNED - 1];
      var isSigned  = signedVal === true || String(signedVal).trim().toUpperCase() === 'TRUE';
      if (isSigned) return;

      updates.push({
        row:     i + 2,
        patient: String(r[PATIENT_IDX] || '').trim(),
        date:    _fmtDate(r[DATE_IDX]),
      });
    });

    updates.forEach(function(u) {
      sheet.getRange(u.row, COL_SIGNED).setValue(true);
    });

    SpreadsheetApp.flush();

    if (updates.length) {
      _audit(ss, 'AUTO_SIGN_BACKFILL',
        'One-time reconciliation: ' + updates.length +
        ' row(s) with TebraStatus=Checked Out flipped to Signed=TRUE ' +
        '(full-sheet scan, no date window).');
    }

    Logger.log('reconcileAllCheckedOutSigned: done. ' + updates.length +
               ' row(s) updated to Signed=TRUE.');
    updates.forEach(function(u) {
      Logger.log('  ✓ ' + u.patient + ' (' + u.date + ') — row ' + u.row);
    });

    return JSON.stringify({ ok: true, updated: updates.length, rows: updates });
  } catch (e) {
    Logger.log('reconcileAllCheckedOutSigned ERROR: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ ok: false, error: e.message });
  }
}

/**
 * ── ONE-TIME CLEANUP (2026-07-26) ──────────────────────────────────────────
 * Historical bug: importFromTebraApi's stale-row detection used to write the
 * literal string 'cancelled in tebra' into Column Y (Status) — the Assistant-
 * owned pre-visit readiness column (valid / pending / issue). That was wrong
 * on two counts: (1) Column Y must be Assistant-input-only, never touched by
 * sync, and (2) the detection itself had a false-positive bug (see the fixed
 * _findStaleRows in importFromTebraApi) that could flag even a legitimate,
 * fully Checked-Out appointment this way if Tebra silently reassigned its
 * internal ID.
 *
 * This function is a one-time, run-it-yourself cleanup for rows already
 * corrupted by the old logic. It ONLY touches Column Y — it blanks out any
 * cell that literally reads "cancelled in tebra" (case-insensitive), restoring
 * it to '' so the assistant can re-set a real value (valid/pending/issue) if
 * one is still needed. It does NOT touch Column AI (TebraStatus) — that
 * column will self-correct on the next Tebra sync now that the fixed logic is
 * in place (still-active appointments get their real status; genuinely
 * vanished ones get 'Deleted in Tebra' written there instead, going forward).
 *
 * Run this ONCE from the Apps Script editor after deploying the fix, then
 * check the log for exactly which rows were touched.
 */
function cleanupCorruptedStatusColumn() {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) {
      Logger.log('cleanupCorruptedStatusColumn: no appointment data found.');
      return JSON.stringify({ ok: true, cleaned: 0 });
    }

    var COL_STATUS_1 = APPT_COLS.indexOf('Status') + 1; // 1-based
    if (COL_STATUS_1 <= 0) {
      Logger.log('cleanupCorruptedStatusColumn: Status column not found.');
      return JSON.stringify({ ok: false, error: 'Status column not found.' });
    }

    var PATIENT_IDX = APPT_COLS.indexOf('Patient');
    var DATE_IDX    = APPT_COLS.indexOf('Date');
    var TEBRA_IDX   = APPT_COLS.indexOf('TebraStatus');
    var lastRow     = sheet.getLastRow();
    var readCols    = Math.max(COL_STATUS_1, PATIENT_IDX + 1, DATE_IDX + 1, TEBRA_IDX + 1);
    var data        = sheet.getRange(2, 1, lastRow - 1, readCols).getValues();

    var cleaned = []; // { row, patient, date, tebraStatus }

    data.forEach(function(r, i) {
      var statusVal = String(r[COL_STATUS_1 - 1] || '').toLowerCase().trim();
      if (statusVal !== 'cancelled in tebra') return;

      cleaned.push({
        row:         i + 2,
        patient:     String(r[PATIENT_IDX] || '').trim(),
        date:        _fmtDate(r[DATE_IDX]),
        tebraStatus: String(r[TEBRA_IDX] || '').trim(),
      });
    });

    cleaned.forEach(function(c) {
      sheet.getRange(c.row, COL_STATUS_1).setValue('');
    });

    SpreadsheetApp.flush();

    if (cleaned.length) {
      _audit(ss, 'STATUS_COL_CLEANUP',
        'One-time cleanup: ' + cleaned.length +
        ' row(s) had Column Y (Status) wrongly set to "cancelled in tebra" ' +
        'by the old stale-detection bug — cleared back to blank.');
    }

    Logger.log('cleanupCorruptedStatusColumn: done. ' + cleaned.length + ' row(s) cleared.');
    cleaned.forEach(function(c) {
      Logger.log('  ✓ ' + c.patient + ' (' + c.date + ') — row ' + c.row +
                 ' — TebraStatus was "' + c.tebraStatus + '"');
    });

    return JSON.stringify({ ok: true, cleaned: cleaned.length, rows: cleaned });
  } catch (e) {
    Logger.log('cleanupCorruptedStatusColumn ERROR: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ ok: false, error: e.message });
  }
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
  } catch (e) {}

  return s;
}


/* ════════════════════════════════════════════════════════════════
   DELETE — APPOINTMENTS
════════════════════════════════════════════════════════════════ */

function deleteAppointment(apptId) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ error: 'No appointments found' });

    const values = sheet.getDataRange().getValues();
    let targetRow   = -1;
    let patientName = '';
    let apptDate    = '';
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][2]) === String(apptId)) {
        targetRow   = i + 1;
        patientName = values[i][4] || '';
        apptDate    = _fmtDate(values[i][1]);
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
          firstName:      String(r[0] || '').trim(),
          lastName:       String(r[1] || '').trim(),
          platform:           String(r[2]  || '').trim(),
          insurance:          String(r[3]  || '').trim(),
          patientPortion:     String(r[4]  || '').trim(),
          rate:               _sv(r[5]).trim(),   // _sv preserves numeric 0 ($0 copay)
          claimPlatform:      String(r[6]  || '').trim(),
          memberID:           String(r[7]  || '').trim(),
          // Sheets stores manually-entered dates as Date objects; convert to YYYY-MM-DD
          memberDOB:          r[8] instanceof Date
                                ? Utilities.formatDate(r[8], Session.getScriptTimeZone(), 'yyyy-MM-dd')
                                : String(r[8]  || '').trim(),
          pcn:                String(r[9]  || '').trim(),
          groupNumber:        String(r[10] || '').trim(),
          primarySubscriber:  String(r[11] || '').trim(),
          patientState:       String(r[12] || '').trim(),
          renderingNPI:       String(r[13] || '').trim(),
          billingNPI:         String(r[14] || '').trim(),
          xCode:              String(r[15] || '').trim(),
          paymentPlatform:    String(r[16] || '').trim(),  // default collection platform
          bestChannel:        String(r[17] || '').trim(),  // saved rate recommendation JSON
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

    var colProv    = APPT_COLS.indexOf('ProvID');
    var colPatient = APPT_COLS.indexOf('Patient');
    if (colProv === -1 || colPatient === -1) {
      return JSON.stringify({ error: 'ProvID/Patient not found in APPT_COLS' });
    }

    var numCols = Math.max(colProv, colPatient) + 1;
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(numCols, sheet.getLastColumn())).getValues();

    // seen[provID] = Set-like object of patient names already counted for that provider
    var seen = {};
    data.forEach(function (row) {
      var provID  = String(row[colProv] || '').trim().toLowerCase();
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
   ONE-TIME CLEANUP — existing placeholder rows (2026-07-27)
   Run this ONCE from the Apps Script editor (select it in the function
   dropdown next to "Run", then click Run) to remove the placeholder
   calendar-block rows that already got written into both sheets before
   the _fetchTebraAppointments source-level fix went in (Jodene Mail,
   Kr Appt1, Lk Block, etc. — see PLACEHOLDER_PATIENT_NAMES at the top of
   this file). Safe to run more than once — it's a no-op if nothing
   matches. Logs a summary (View → Executions after running) with exactly
   which rows were removed from each sheet.

   PERFORMANCE (2026-07-27): the first version of this function called
   sheet.deleteRow() once per matching row. That's fine for 2-3 rows, but
   these calendar blocks are recurring, so months of daily Tebra syncs had
   quietly piled up far more than the 3 rows Dean originally spotted —
   each deleteRow() call forces Sheets to re-lay-out everything below it,
   and doing that dozens/hundreds of times in a row is what made this spin
   for 3+ minutes before it was stopped. Fixed by reading the whole sheet
   once, filtering in memory, writing the kept rows back with a single
   setValues() call, then trimming the now-unused tail with a single
   deleteRows() call — 2-3 sheet operations total instead of one per row,
   regardless of how many placeholder rows actually exist.
════════════════════════════════════════════════════════════════ */
function cleanupPlaceholderPatients() {
  var removedAppts = [];
  var removedPatients = [];

  removedAppts = _cleanupPlaceholdersFromSheet(
    TAB_APPT,
    APPT_COLS.indexOf('Patient'),
    function (row) {
      return row[APPT_COLS.indexOf('ProvID')] + ' / ' + row[APPT_COLS.indexOf('Patient')] + ' / ' + row[APPT_COLS.indexOf('Date')];
    }
  );

  removedPatients = _cleanupPlaceholdersFromSheet(
    TAB_PATIENT,
    null, // matched via a combined first+last check below instead of a single column
    function (row) {
      return String(row[PATIENT_COLS.indexOf('FirstName')] || '').trim() + ' ' + String(row[PATIENT_COLS.indexOf('LastName')] || '').trim();
    },
    function (row) {
      var full = (String(row[PATIENT_COLS.indexOf('FirstName')] || '').trim() + ' ' + String(row[PATIENT_COLS.indexOf('LastName')] || '').trim()).trim().toUpperCase();
      return PLACEHOLDER_PATIENT_NAMES.indexOf(full) !== -1;
    }
  );

  var summary = {
    appointmentsRemoved: removedAppts.length,
    appointmentRows:     removedAppts,
    patientsRemoved:     removedPatients.length,
    patientRows:         removedPatients,
  };
  Logger.log('cleanupPlaceholderPatients: ' + JSON.stringify(summary, null, 2));
  return JSON.stringify(summary);
}

// Shared bulk-rewrite helper — reads the whole sheet once, filters out rows
// that match PLACEHOLDER_PATIENT_NAMES (either by a single column, via
// matchCol, or a custom isMatch predicate for multi-column names like
// Patients' FirstName+LastName), writes the kept rows back in one shot,
// then deletes the leftover tail rows in one shot. Returns the list of
// removed-row labels (for logging).
function _cleanupPlaceholdersFromSheet(tabName, matchCol, labelFn, isMatchFn) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var data    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  var isMatch = isMatchFn || function (row) {
    return PLACEHOLDER_PATIENT_NAMES.indexOf(String(row[matchCol] || '').trim().toUpperCase()) !== -1;
  };

  var removed = [];
  var kept = [];
  data.forEach(function (row) {
    if (isMatch(row)) {
      removed.push(labelFn(row));
    } else {
      kept.push(row);
    }
  });

  if (!removed.length) return []; // nothing to do — leave the sheet untouched

  if (kept.length) {
    sheet.getRange(2, 1, kept.length, lastCol).setValues(kept);
  }
  var clearFrom  = 2 + kept.length;
  var clearCount = lastRow - clearFrom + 1;
  if (clearCount > 0) {
    sheet.deleteRows(clearFrom, clearCount); // one bulk structural op, not one per row
  }

  return removed;
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
    var ss     = SpreadsheetApp.getActiveSpreadsheet();
    var sheet  = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify([]);
    var data   = sheet.getDataRange().getValues();
    var hdr    = data[0];

    var tz       = Session.getScriptTimeZone();
    var today    = new Date();
    var start    = new Date(today); start.setDate(today.getDate() - 60); // 2 months back
    var startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    var endStr   = Utilities.formatDate(today, tz, 'yyyy-MM-dd');        // today only — no future

    var PLACEHOLDER_NAMES_NB = PLACEHOLDER_PATIENT_NAMES;  // shared list — see top of file

    var out = [];
    for (var i = 1; i < data.length; i++) {
      var r   = data[i];
      var appt = rowToAppt(r);
      if (!appt.id || !appt.date) continue;
      if (appt.date < startStr || appt.date > endStr) continue;
      if (provFilter && provFilter !== '' && appt.provID !== provFilter) continue;
      // Skip placeholder patients (calendar blocks / personal day holds)
      if (PLACEHOLDER_NAMES_NB.indexOf(String(appt.patient || '').trim().toUpperCase()) !== -1) continue;
      out.push({
        id:         appt.id,
        date:       appt.date,
        time:       appt.time,
        patient:    appt.patient,
        provID:     appt.provID,
        noteStatus: appt.noteStatus || '',
        signed:     appt.out || false,
      });
    }
    // Sort by date then time
    out.sort(function(a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.time < b.time ? -1 : 1;
    });
    return JSON.stringify(out);
  } catch(e) {
    Logger.log('getNoteBoard ERROR: ' + e.message);
    return JSON.stringify([]);
  }
}

/* ─────────────────────────────────────────────────────────────────
   SAVE NOTE STATUS
   Lightweight update — writes only the NoteStatus column for a
   given appointment ID. Called by the Note Board panel so assistants
   can update note status without a full appointment save.
────────────────────────────────────────────────────────────────── */
function saveNoteStatus(apptId, noteStatus) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet || sheet.getLastRow() < 2) return JSON.stringify({ ok: false });
    var data  = sheet.getDataRange().getValues();
    var ID_IDX = APPT_COLS.indexOf('ApptID');     // column C (index 2)
    var NS_IDX = APPT_COLS.indexOf('NoteStatus'); // column index 55
    if (NS_IDX < 0) return JSON.stringify({ ok: false, err: 'NoteStatus column not found' });
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][ID_IDX] || '').trim() === String(apptId).trim()) {
        sheet.getRange(i + 1, NS_IDX + 1).setValue(noteStatus || '');
        _audit(ss, 'NOTE_STATUS_UPDATED',
               'Appt ' + apptId + ' → noteStatus=' + (noteStatus || '(cleared)'));
        return JSON.stringify({ ok: true });
      }
    }
    return JSON.stringify({ ok: false, err: 'Appointment not found: ' + apptId });
  } catch(e) {
    Logger.log('saveNoteStatus ERROR: ' + e.message);
    return JSON.stringify({ ok: false, err: e.message });
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
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patSheet  = ss.getSheetByName(TAB_PATIENT);
    if (!apptSheet || apptSheet.getLastRow() < 2) return JSON.stringify([]);

    // ── Build patient lookup: fullName (lowercase) → { memberID, insurance, claimPlatform }
    var patLookup = {};
    if (patSheet && patSheet.getLastRow() >= 2) {
      patSheet.getDataRange().getValues().slice(1).forEach(function(r) {
        var fname = String(r[0] || '').trim();
        var lname = String(r[1] || '').trim();
        if (!fname && !lname) return;
        var key = (fname + ' ' + lname).toLowerCase().replace(/\s+/g,' ').trim();
        patLookup[key] = {
          memberID:      String(r[7]  || '').trim(),
          insurance:     String(r[3]  || '').trim(),
          claimPlatform: String(r[6]  || '').trim(),
        };
      });
    }

    // ── Filter and enrich appointment rows
    var rows   = apptSheet.getDataRange().getValues().slice(1);
    var claims = [];

    rows.forEach(function(r) {
      // Only include rows where a claim has been submitted
      var submittedDate = String(r[39] || '').trim();
      if (!submittedDate) return;

      var rowProv = String(r[0] || '');
      if (provFilter && provFilter !== '*' && rowProv !== provFilter) return;

      var appt    = rowToAppt(r);

      // ── Only Clinic Submit (direct) appointments belong in the Claims Ledger ──
      // Source of truth: Method column (col F, index 5). Platform-billed appointments
      // (Alma, Headway, Grow) are excluded regardless of whether they have a submitted date.
      if (appt.method !== 'direct') return;

      var ptKey   = _normName(appt.patient);
      var ptInfo  = patLookup[ptKey] || {};

      // Insurance carrier: appointment's directIns takes priority, then patient record
      var carrier = appt.directIns || ptInfo.insurance || 'Other';

      claims.push({
        provID:            appt.provID,
        id:                appt.id,
        patient:           appt.patient,
        memberID:          ptInfo.memberID || '',
        carrier:           carrier,
        date:              appt.date,
        cpt:               appt.cpt,
        claimSubmittedDate: appt.claimSubmittedDate,
        claimPlatform:     ptInfo.claimPlatform || '',
        claimID:           appt.claimID,
        claimStatus:       appt.claimStatus,
        claimStatusNotes:  appt.claimStatusNotes,
        claimPaidDate:     appt.claimPaidDate,
        claimPaidAmount:   appt.claimPaidAmount,
        claimCheckID:      appt.claimCheckID,
        claimERA:          appt.claimERA,
        claimBundled:      appt.claimBundled,
        claimBundledAmount: appt.claimBundledAmount,
        claimDepositBank:  appt.claimDepositBank,
        claimDepositDate:  appt.claimDepositDate,
        claimDepositAmount: appt.claimDepositAmount,
        // Copay info for Copay/Notes column
        paymentType:       appt.paymentType,
        paymentRate:       appt.paymentRate,
        paymentCollected:  appt.paymentCollected,
        paymentFailed:     appt.paymentFailed,
        paymentAmount:     appt.paymentAmount,
        paymentDate:       appt.paymentDate,
        // PPC (Payment Processing Channel) — added for the Copay/Notes column
        // rebuild; already stored per-appointment via rowToAppt, just wasn't
        // surfaced to the Claims Ledger before.
        paymentPlatform:   appt.paymentPlatform,
      });
    });

    // Sort: by carrier, then patient name, then appointment date ascending
    claims.sort(function(a, b) {
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
   Only touches ClaimStatusNotes (col AQ, 0-based index 42).
════════════════════════════════════════════════════════════════ */
function saveClaimNotes(provId, dateStr, apptId, notes) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet) return JSON.stringify({ error: 'Appointments sheet not found' });

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var r = data[i];
      // Match by ApptID (index 2) — unique identifier — with ProvID (index 0) as guard
      if (String(r[2]) === String(apptId) && String(r[0]) === String(provId)) {
        // ClaimStatusNotes is APPT_COLS index 42 → spreadsheet column 43 (1-based)
        sheet.getRange(i + 1, APPT_COLS.indexOf('ClaimStatusNotes') + 1)
             .setValue(notes || '');
        return JSON.stringify({ ok: true });
      }
    }
    return JSON.stringify({ error: 'Appointment not found' });
  } catch(e) {
    Logger.log('saveClaimNotes error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   USER INFO & ROLE
════════════════════════════════════════════════════════════════ */

function getCurrentUserWithRole() {
  try {
    const email = Session.getActiveUser().getEmail();
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const staff = _getStaffRecord(ss, email);
    if (!staff) {
      Logger.log('Unrecognized user: ' + email);
      return JSON.stringify({ email, role: 'unknown', provID: '', displayName: email });
    }
    return JSON.stringify(staff);
  } catch (e) {
    Logger.log('getCurrentUserWithRole error: ' + e.message);
    return JSON.stringify({ email: '', role: 'unknown', provID: '', displayName: '' });
  }
}


/* ════════════════════════════════════════════════════════════════
   INTERNAL HELPERS
════════════════════════════════════════════════════════════════ */

function _apptSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB_APPT);
}

function _getStaffRecord(ss, email) {
  const sheet = ss.getSheetByName(TAB_STAFF);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const rows  = sheet.getDataRange().getValues().slice(1);
  const row   = rows.find(r => String(r[0]).toLowerCase().trim() === email.toLowerCase().trim());
  if (!row) return null;
  return {
    email:       String(row[0] || '').trim(),
    role:        String(row[1] || 'unknown').trim(),
    provID:      String(row[2] || '').trim(),
    displayName: String(row[3] || '').trim(),
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
  if (v === true  || v === 'TRUE'  || v === 'true')  return true;
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
  var h  = parseInt(m[1], 10);
  var mi = m[2];
  var p  = (m[3] || '').toUpperCase();
  if (p === 'PM' && h !== 12) h += 12;
  if (p === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + mi;
}

function rowToAppt(r) {
  return {
    provID:   String(r[0]  || ''),   // column A — needed for NPI dropdown in ClaimSubmitModal
    id:       String(r[2]),
    date:     _fmtDate(r[1]),
    time:     _fmtTime(r[3]),
    patient:  String(r[4]  || ''),
    // Unknown/blank Method cell → blank, NOT a default channel (Solrei brand rule).
    method:   String(r[5]  || ''),
    alma:   { text: String(r[6]  || ''), valid: _nb(r[7])  },
    hw:     { text: String(r[8]  || ''), valid: _nb(r[9])  },
    grow:   { text: String(r[10] || ''), valid: _nb(r[11]) },
    directIns: String(r[12] || ''),
    // DirectValid (index 48) stores the explicit valid/issue/null flag for direct-pay.
    // Falls back to presence of directIns text for rows created before this column existed.
    direct: { text: String(r[12] || ''), valid: r[48] !== undefined && r[48] !== '' ? _nb(r[48]) : (r[12] ? true : null) },
    intake:  _nb(r[13]),
    ins:     _nb(r[14]),
    autopay: _nb(r[15]),
    scr: {
      'PHQ-9': _nb(r[16]),
      'GAD-7': _nb(r[17]),
      'PCL-5': _nb(r[18]),
    },
    ccEhr:    String(r[19] || ''),
    notes:    String(r[20] || ''),
    unsigned: r[21] ? String(r[21]).split(',').map(s => s.trim()).filter(Boolean) : [],
    cpt:      r[22] ? String(r[22]).split(/[|,;]/).map(s => s.trim()).filter(Boolean) : [],
    billing:  String(r[23] || 'pending'),
    status:   String(r[24] || 'pending'),
    out:      r[25] === true || r[25] === 'TRUE',
    paymentType:      String(r[26] || ''),
    paymentRate:      _sv(r[27]),   // _sv preserves numeric 0 ($0 copay rate)
    paymentAmount:    String(r[28] || ''),
    paymentCollected: r[29] === true || r[29] === 'TRUE',
    paymentFailed:    r[30] === true || r[30] === 'TRUE',
    comms: (() => {
      try { return r[31] ? JSON.parse(String(r[31])) : []; }
      catch (e) { return []; }
    })(),
    tebraStatus:  String(r[34] || ''),
    paymentDate:  _fmtDate(r[35]),
    rxMeds:          r[36] ? String(r[36]).split('|').map(s => s.trim()).filter(Boolean) : [],
    rxBillerAlert:   r[37] === true || r[37] === 'TRUE',
    paymentPlatform: String(r[38] || ''),
    // ── Claim tracking & payout (cols AN-AV, indices 39-47) ──────────────
    claimSubmittedDate: _fmtDate(r[39]),
    claimID:            String(r[40] || ''),
    claimStatus:        String(r[41] || ''),
    claimStatusNotes:   String(r[42] || ''),
    claimPaidDate:      _fmtDate(r[43]),
    claimPaidAmount:    String(r[44] || ''),
    claimCheckID:       String(r[45] || ''),
    claimDepositBank:   String(r[46] || ''),
    claimDepositDate:   _fmtDate(r[47]),
    // ── Claims Ledger supplemental (indices 49-52) ────────────────────────
    claimERA:           String(r[49] || ''),
    claimBundled:       r[50] === true || r[50] === 'TRUE',
    claimBundledAmount: String(r[51] || ''),
    claimDepositAmount: String(r[52] || ''),
    // ── Patient context — denormalized from Patient DB (indices 53-54) ──────
    insuranceCarrier:   String(r[53] || ''),
    patientState:       String(r[54] || ''),
    // ── Clinic Note Status (index 55) ────────────────────────────────────────
    noteStatus:         String(r[55] || ''),
    // ── Screener scores + assistant notes (indices 56-58) ────────────────────
    scrData: (() => {
      try { return r[56] ? JSON.parse(String(r[56])) : { 'PHQ-9': { score: '' }, 'GAD-7': { score: '' }, 'PCL-5': { score: '' } }; }
      catch (e) { return { 'PHQ-9': { score: '' }, 'GAD-7': { score: '' }, 'PCL-5': { score: '' } }; }
    })(),
    scrNote:       String(r[57] || ''),
    checklistNote: String(r[58] || ''),
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
    appt.alma?.text   || '',
    appt.alma?.valid  ?? '',
    appt.hw?.text     || '',
    appt.hw?.valid    ?? '',
    appt.grow?.text   || '',
    appt.grow?.valid  ?? '',
    appt.directIns    || '',
    appt.intake       ?? '',
    appt.ins          ?? '',
    appt.autopay      ?? '',
    appt.scr?.['PHQ-9'] ?? '',
    appt.scr?.['GAD-7'] ?? '',
    appt.scr?.['PCL-5'] ?? '',
    appt.ccEhr        || '',
    appt.notes        || '',
    (appt.unsigned || []).join(','),
    (appt.cpt      || []).join('|'),
    appt.billing   || 'pending',
    appt.status    || 'pending',
    appt.out ? true : false,
    appt.paymentType   || '',
    _sv(appt.paymentRate),    // _sv preserves '0' / numeric 0 ($0 copay)
    appt.paymentAmount || '',
    appt.paymentCollected ? true : false,
    appt.paymentFailed    ? true : false,
    JSON.stringify(appt.comms || []),
    new Date(),
    Session.getActiveUser().getEmail(),
    appt.tebraStatus    || '',
    appt.paymentDate    || '',
    (appt.rxMeds || []).join('|'),
    appt.rxBillerAlert  ? true : false,
    appt.paymentPlatform || '',
    // ── Claim tracking & payout (indices 39-47) ──────────────────────────
    appt.claimSubmittedDate || '',
    appt.claimID            || '',
    appt.claimStatus        || '',
    appt.claimStatusNotes   || '',
    appt.claimPaidDate      || '',
    appt.claimPaidAmount    || '',
    appt.claimCheckID       || '',
    appt.claimDepositBank   || '',
    appt.claimDepositDate   || '',
    // Index 48 — DirectValid: explicit valid/issue/null flag for direct-pay appointments.
    // Mirrors AlmaValid (idx 7), HWValid (idx 9), GrowValid (idx 11).
    appt.direct?.valid        ?? '',
    // Indices 49-52 — Claims Ledger supplemental fields
    appt.claimERA             || '',
    appt.claimBundled         ? true : false,
    appt.claimBundledAmount   || '',
    appt.claimDepositAmount   || '',
    // Indices 53-54 — Patient context (denormalized from Patient DB)
    appt.insuranceCarrier     || '',
    appt.patientState         || '',
    // Index 55 — Clinic Note Status
    appt.noteStatus           || '',
    // Indices 56-58 — Screener scores + assistant notes (added for PatientInfoModal)
    appt.scrData ? JSON.stringify(appt.scrData) : '',   // index 56 — ScrData
    appt.scrNote        || '',                           // index 57 — ScrNote
    appt.checklistNote  || '',                           // index 58 — ChecklistNote
  ];
}

/* ── _isValidUSState: returns true for valid 2-letter US state/territory codes ─
   Used to guard PatientState reads so PrimarySubscriber or other non-state
   data never gets written into the PatientState column.
────────────────────────────────────────────────────────────────────────────── */
var VALID_US_STATES = {
  AL:1,AK:1,AZ:1,AR:1,CA:1,CO:1,CT:1,DE:1,FL:1,GA:1,
  HI:1,ID:1,IL:1,IN:1,IA:1,KS:1,KY:1,LA:1,ME:1,MD:1,
  MA:1,MI:1,MN:1,MS:1,MO:1,MT:1,NE:1,NV:1,NH:1,NJ:1,
  NM:1,NY:1,NC:1,ND:1,OH:1,OK:1,OR:1,PA:1,RI:1,SC:1,
  SD:1,TN:1,TX:1,UT:1,VT:1,VA:1,WA:1,WV:1,WI:1,WY:1,
  DC:1,PR:1,VI:1,GU:1,AS:1,MP:1
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
    var hdr           = rows[0].map(function(h) { return String(h || '').trim(); });
    var COL_INSURANCE = hdr.indexOf('InsuranceCarrier'); // fallback: PATIENT_COLS index 3
    var COL_STATE     = hdr.indexOf('PatientState'); // fallback: PATIENT_COLS index 12
    if (COL_INSURANCE < 0) COL_INSURANCE = 3;
    if (COL_STATE     < 0) COL_STATE     = 12;
    var norm = _normName(patientName);
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var fullName = _normName(String(r[0] || '') + ' ' + String(r[1] || ''));
      if (fullName === norm) {
        var rawState = String(r[COL_STATE] || '').trim().toUpperCase();
        return {
          insurance:    String(r[COL_INSURANCE] || ''),
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
      'jodene':  'jodene',
      'jensen':  'jodene',
      'katie':   'katie',
      'robins':  'katie',
      'megan':   'megan',
      'lori':    'lori',
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
    const errors       = [];
    let currentProvID  = null;
    let currentDate    = null;

    for (var i = 0; i < allRows.length; i++) {
      var row  = allRows[i];
      var colA = row[0];
      var colB = row[1];
      var colD = row[3];
      var colP = row[15];

      if (colA && !colB && typeof colA === 'string' && colA.trim().length > 3) {
        var pid = resolveProvID(colA);
        if (pid) {
          currentProvID = pid;
          currentDate   = null;
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
          provID:  currentProvID,
          date:    currentDate,
          time:    apptTime,
          patient: patientName,
        });
      }
    }

    if (dryRun) {
      Logger.log('DRY RUN — ' + appointments.length + ' appointments parsed.');
      return JSON.stringify({
        dryRun:       true,
        parsed:       appointments.length,
        appointments: appointments,
        errors:       errors,
      });
    }

    const ss        = SpreadsheetApp.getActiveSpreadsheet();
    const apptSheet = ss.getSheetByName(TAB_APPT);

    if (!apptSheet) {
      return JSON.stringify({ error: 'Appointments sheet not found — run initializeSheets() first' });
    }

    var patientLookup = {};
    const PLATFORM_TO_METHOD = { 'alma': 'alma', 'headway': 'hw', 'grow': 'grow', 'direct': 'direct' };
    var patSheet = ss.getSheetByName(TAB_PATIENT);
    if (patSheet && patSheet.getLastRow() > 1) {
      patSheet.getRange(2, 1, patSheet.getLastRow() - 1, 6).getValues().forEach(function(r) {
        var first = String(r[0] || '').trim();
        var last  = String(r[1] || '').trim();
        if (!first && !last) return;
        var fullName = (first + ' ' + last).trim().toLowerCase();
        var platform = String(r[2] || '').trim().toLowerCase();
        patientLookup[fullName] = {
          // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
          method:         PLATFORM_TO_METHOD[platform] || '',
          insurance:      String(r[3] || '').trim(),
          patientPortion: String(r[4] || '').trim(),
          rate:           _sv(r[5]).trim(),   // _sv preserves numeric 0 ($0 copay)
        };
      });
    }
    Logger.log('Patient lookup built: ' + Object.keys(patientLookup).length + ' patients');

    var existingKeys = new Set();
    if (apptSheet.getLastRow() > 1) {
      var existing = apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, 4).getValues();
      existing.forEach(function(r) {
        existingKeys.add(r[0] + '||' + _fmtDate(r[1]) + '||' + _normalizeTimeKey(r[3]));
      });
    }

    var imported = 0;
    var skipped  = 0;

    appointments.forEach(function(appt) {
      var key = appt.provID + '||' + appt.date + '||' + _normalizeTimeKey(appt.time);
      if (existingKeys.has(key)) {
        skipped++;
        return;
      }

      var ptInfo   = patientLookup[appt.patient.toLowerCase()] || {};
      // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
      var method   = ptInfo.method || '';
      var isDirect = method === 'direct';

      var apptId = 'TEBRA-' + new Date().getTime() + '-' +
                   Math.random().toString(36).substr(2, 4).toUpperCase();

      var rowData = apptToRow({
        id:               apptId,
        time:             appt.time,
        patient:          appt.patient,
        method:           method,
        alma:             { text: '', valid: null },
        hw:               { text: '', valid: null },
        grow:             { text: '', valid: null },
        directIns:        ptInfo.insurance || '',
        intake:           null,
        ins:              null,
        autopay:          null,
        scr:              { 'PHQ-9': null, 'GAD-7': null, 'PCL-5': null },
        ccEhr:            '',
        notes:            'Imported from Tebra',
        unsigned:         [],
        cpt:              [],
        billing:          'pending',
        status:           'pending',
        out:              false,
        paymentType:      isDirect ? ptInfo.patientPortion : '',
        paymentRate:      isDirect ? ptInfo.rate            : '',
        paymentAmount:    '',
        paymentCollected: false,
        paymentFailed:    false,
        comms:            [],
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
      skipped:  skipped,
      total:    appointments.length,
      errors:   errors,
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
  'jodene':  'jodene',
  'jensen':  'jodene',   // Jodene's last name
  'katie':   'katie',
  'robins':  'katie',    // Katie's last name
  'megan':   'megan',
  'lori':    'lori',
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
    Logger.log('    TEBRA_PASSWORD     : ' + (c.password    ? '✅ set' : '❌ MISSING'));
    Logger.log('    TEBRA_USER         : ' + (c.user        ? '✅ set' : '❌ MISSING'));
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
    password:    p.getProperty('TEBRA_PASSWORD')     || '',
    user:        p.getProperty('TEBRA_USER')         || '',
  };
}

function _xmlEscape(s) {
  return String(s || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

function _tebraHeader(c) {
  return '<ns:RequestHeader>' +
    '<ns:CustomerKey>' + _xmlEscape(c.customerKey) + '</ns:CustomerKey>' +
    '<ns:Password>'    + _xmlEscape(c.password)    + '</ns:Password>'    +
    '<ns:User>'        + _xmlEscape(c.user)        + '</ns:User>'        +
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
    method:  'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction':   soapAction,
    },
    payload:            envelope,
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

function _parseTebraApiDate(s) {
  if (!s) return '';
  var p = s.split('/');
  if (p.length !== 3) return s;
  return p[2] + '-' + String(p[0]).padStart(2, '0') + '-' + String(p[1]).padStart(2, '0');
}

function _parseTebraApiTime(s) {
  if (!s) return '';
  s = s.trim();
  var ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i.exec(s);
  if (ampm) {
    var h = parseInt(ampm[1], 10);
    var m = ampm[2];
    var period = ampm[3].toUpperCase();
    if (period === 'PM' && h !== 12) h += 12;
    if (period === 'AM' && h === 12) h = 0;
    var isPM2 = h >= 12;
    var h12   = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return h12 + ':' + m + (isPM2 ? 'PM' : 'AM');
  }
  var h24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (h24) {
    var h = parseInt(h24[1], 10);
    var m = h24[2];
    var isPM = h >= 12;
    var h12  = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return h12 + ':' + m + (isPM ? 'PM' : 'AM');
  }
  return s;
}

function _parseTebraStartDate(s) {
  if (!s) return { date: '', time: '' };
  s = s.trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):\d{2}\s*(AM|PM)$/i);
  if (!m) return { date: '', time: s };

  var mo     = parseInt(m[1], 10) - 1;
  var dy     = parseInt(m[2], 10);
  var yr     = parseInt(m[3], 10);
  var hr     = parseInt(m[4], 10);
  var min    = parseInt(m[5], 10);
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
  return String(s).toLowerCase().replace(/\b\w/g, function(c) {
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
  el.getChildren().forEach(function(child) {
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
    appts.forEach(function(a, i) {
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

  var today      = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
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
        '<ns:EndDate>'   + startTebra + '</ns:EndDate>'   +
      '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  try {
    var text = _tebraPost('GetAppointments', bodyXml);
    var doc  = XmlService.parse(text);
    var root = doc.getRootElement();

    var apptEls = [];
    _findXmlElements(root, 'AppointmentData', apptEls);
    Logger.log('=== testTebraProviders: ' + apptEls.length + ' patient appointments for ' + today + ' ===');

    // Dump the raw XML of the first element so we can see the exact structure
    if (apptEls.length) {
      try {
        Logger.log('── First AppointmentData raw XML ──');
        Logger.log(XmlService.getRawFormat().format(apptEls[0]).substr(0, 2000));
      } catch(e) { /* non-critical */ }
    }

    apptEls.forEach(function(el, i) {
      var name    = _findFirstXml(el, 'PatientFullName');
      var res1    = _findFirstXml(el, 'ResourceName1');
      var resId1  = _findFirstXml(el, 'ResourceID1');
      var status  = _findFirstXml(el, 'ConfirmationStatus');
      var start   = _findFirstXml(el, 'StartDate');
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
// DIAGNOSTIC: Fetches the Tebra WSDL and logs the
// AppointmentFieldsToReturn type definition — shows the exact
// field names the API accepts in the <Fields> section.
// Run once, then check View → Logs.
// ─────────────────────────────────────────────────────────────────
function testTebraWsdl() {
  var BASE = TEBRA_ENDPOINT + '?xsd=';
  // xsd0 = main Kareo schemas; xsd5 = AppointmentService.Model — most likely to hold
  // AppointmentFieldsToReturn.  We also check xsd2 and xsd4 as fallbacks.
  var candidates = ['xsd0', 'xsd5', 'xsd2', 'xsd4'];

  candidates.forEach(function(xsd) {
    try {
      Logger.log('── Fetching ' + xsd + ' ──────────────────────────────');
      var resp = UrlFetchApp.fetch(BASE + xsd, { muteHttpExceptions: true });
      var text = resp.getContentText();
      var idx  = text.indexOf('AppointmentFieldsToReturn');
      if (idx === -1) {
        Logger.log(xsd + ': AppointmentFieldsToReturn NOT found (' + text.length + ' chars total)');
      } else {
        Logger.log(xsd + ': FOUND at pos ' + idx + ' — logging 3000 chars from that point:');
        Logger.log(text.substring(idx, idx + 3000));
      }
    } catch (e) {
      Logger.log(xsd + ': fetch error — ' + e.message);
    }
  });
}

/**
 * Diagnostic — scan the AppointmentFieldsToReturn XSD type and log every
 * element name that contains "insur", "case", "policy", or "plan" (all
 * case-insensitive).  Run this to find the correct insurance field name.
 *
 * Also dumps ALL element names in the type so you can grep the full list
 * if the filter misses something.
 */
function testTebraFindInsuranceField() {
  var BASE = TEBRA_ENDPOINT + '?xsd=';
  var xsdList = ['xsd0', 'xsd1', 'xsd2', 'xsd3', 'xsd4', 'xsd5', 'xsd6', 'xsd7'];

  xsdList.forEach(function(xsd) {
    try {
      var text = UrlFetchApp.fetch(BASE + xsd, { muteHttpExceptions: true }).getContentText();
      var typeIdx = text.indexOf('AppointmentFieldsToReturn');
      if (typeIdx === -1) return;  // not in this schema

      Logger.log('══ Found AppointmentFieldsToReturn in ' + xsd +
                 ' at pos ' + typeIdx + ' ══');

      // Grab ~8000 chars from the type definition
      var snippet = text.substring(typeIdx, typeIdx + 8000);

      // Extract all xs:element names within the type block
      var nameRe  = /name="([^"]+)"/g;
      var allNames = [];
      var m;
      while ((m = nameRe.exec(snippet)) !== null) {
        allNames.push(m[1]);
      }

      Logger.log('All element names in AppointmentFieldsToReturn (' +
                 allNames.length + ' total):');
      Logger.log(allNames.join(', '));

      // Filter for insurance / case / policy / plan / carrier
      var keywords = ['insur', 'case', 'policy', 'plan', 'carrier', 'payer'];
      var matches  = allNames.filter(function(n) {
        var lower = n.toLowerCase();
        return keywords.some(function(kw) { return lower.indexOf(kw) !== -1; });
      });

      if (matches.length) {
        Logger.log('');
        Logger.log('▶ Insurance-related field candidates: ' + matches.join(', '));
      } else {
        Logger.log('▶ No insurance-related field names found with current keywords.');
      }

    } catch (e) {
      Logger.log(xsd + ' error: ' + e.message);
    }
  });
}

/**
 * Diagnostic — fetch today's appointments requesting all three case fields
 * (PatientCaseID, PatientCaseName, PatientCasePayerScenario) and dump the raw
 * XML of the first few AppointmentData elements.  This tells us whether the
 * case fields are populated in the Tebra response or truly empty.
 *
 * Run from the Apps Script editor, then inspect the execution log.
 */
function testTebraPatientCaseFields() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  var tz         = Session.getScriptTimeZone();
  var today      = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var startTebra = _tebraDateFmt(_parseYMD(today));

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
      _tebraHeader(c) +
      '<ns:Fields>' +
        '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
        '<ns:ID>true</ns:ID>' +
        '<ns:PatientCaseID>true</ns:PatientCaseID>' +
        '<ns:PatientCaseName>true</ns:PatientCaseName>' +
        '<ns:PatientCasePayerScenario>true</ns:PatientCasePayerScenario>' +
        '<ns:PatientFullName>true</ns:PatientFullName>' +
        '<ns:ResourceName1>true</ns:ResourceName1>' +
        '<ns:StartDate>true</ns:StartDate>' +
      '</ns:Fields>' +
      '<ns:Filter>' +
        '<ns:StartDate>' + startTebra + '</ns:StartDate>' +
        '<ns:EndDate>'   + startTebra + '</ns:EndDate>'   +
      '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  var text = _tebraPost('GetAppointments', bodyXml);

  // Find the first few AppointmentData blocks and log them
  var doc      = XmlService.parse(text);
  var root     = doc.getRootElement();
  var apptEls  = [];
  _findXmlElements(root, 'AppointmentData', apptEls);

  Logger.log('Total appointments returned: ' + apptEls.length);

  var limit = Math.min(apptEls.length, 5);
  for (var i = 0; i < limit; i++) {
    var el = apptEls[i];
    Logger.log('──── AppointmentData[' + i + '] ────');
    Logger.log('  PatientFullName:          ' + _findFirstXml(el, 'PatientFullName'));
    Logger.log('  StartDate:                ' + _findFirstXml(el, 'StartDate'));
    Logger.log('  ResourceName1:            ' + _findFirstXml(el, 'ResourceName1'));
    Logger.log('  PatientCaseID:            ' + _findFirstXml(el, 'PatientCaseID'));
    Logger.log('  PatientCaseName:          ' + _findFirstXml(el, 'PatientCaseName'));
    Logger.log('  PatientCasePayerScenario: ' + _findFirstXml(el, 'PatientCasePayerScenario'));
    Logger.log('  ConfirmationStatus:       ' + _findFirstXml(el, 'ConfirmationStatus'));
  }
}

// ─────────────────────────────────────────────────────────────────
// MAINTENANCE: call once after adding columns to APPT_COLS to
// update the header row in the Appointments sheet.
// Safe to run on a live sheet — only updates row 1.
// ─────────────────────────────────────────────────────────────────
function updateSheetHeaders() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
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
  provId  = provId  || 1;
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
        '<ns:EndDate>'   + tDate + '</ns:EndDate>'   +
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
    'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR',
    'california':'CA','colorado':'CO','connecticut':'CT','delaware':'DE',
    'd.c.':'DC','dc':'DC','district of columbia':'DC','washington dc':'DC','washington d.c.':'DC',
    'florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID',
    'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
    'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
    'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
    'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
    'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
    'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
    'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
    'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
    'vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
    'wisconsin':'WI','wyoming':'WY'
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
  var idToState   = {};
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
                '<sch:Password>'    + _xmlEscape(c.password)    + '</sch:Password>'    +
                '<sch:User>'        + _xmlEscape(c.user)        + '</sch:User>'        +
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
      method:             'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction':   'http://www.kareo.com/api/schemas/KareoServices/GetServiceLocations',
      },
      payload:            envelope,
      muteHttpExceptions: true,
    });
    var text = resp.getContentText();
    Logger.log('🔍 GetServiceLocations raw (first 800): ' + text.substr(0, 800));

    var doc  = XmlService.parse(text);
    var root = doc.getRootElement();

    // Check auth
    var secEls = [];
    _findXmlElements(root, 'SecurityResponse', secEls);
    if (secEls.length) {
      Logger.log('  GetServiceLocations auth: Authenticated=' + _findFirstXml(secEls[0], 'Authenticated') +
                 ' SecurityResult=' + _findFirstXml(secEls[0], 'SecurityResult'));
    }

    var els  = [];
    _findXmlElements(root, 'ServiceLocationData', els);
    Logger.log('  ServiceLocationData elements found: ' + els.length);
    els.forEach(function(el) {
      var name  = _findFirstXml(el, 'Name');
      var id    = _findFirstXml(el, 'ID');
      var abbr  = _extractStateFromLocationName(name);
      Logger.log('  Location: "' + name + '" → abbr="' + abbr + '"');
      if (abbr) {
        if (name) nameToState[name] = abbr;
        if (id)   idToState[id]     = abbr;
      }
    });
    Logger.log('✅  Service location map: ' + Object.keys(nameToState).length +
               ' locations → ' + JSON.stringify(nameToState));
  } catch(e) {
    Logger.log('⚠️  _fetchServiceLocationMap failed (non-fatal): ' + e.message);
  }
  return { nameToState: nameToState, idToState: idToState };
}


function _fetchTebraAppointments(c, startDateStr, endDateStr) {
  var startTebra = _tebraDateFmt(_parseYMD(startDateStr));
  var endTebra   = _tebraDateFmt(_parseYMD(endDateStr));

  var bodyXml =
    '<ns:GetAppointments><ns:request>' +
      _tebraHeader(c) +
      '<ns:Fields>' +
        '<ns:ConfirmationStatus>true</ns:ConfirmationStatus>' +
        '<ns:ID>true</ns:ID>' +
        '<ns:PatientCaseID>true</ns:PatientCaseID>' +
        '<ns:PatientCaseName>true</ns:PatientCaseName>' +
        '<ns:PatientFullName>true</ns:PatientFullName>' +
        '<ns:ResourceID1>true</ns:ResourceID1>' +
        '<ns:ResourceName1>true</ns:ResourceName1>' +
        '<ns:StartDate>true</ns:StartDate>' +
        // NOTE: ServiceLocationName and ServiceLocationID are NOT valid Fields for
        // GetAppointments — requesting them causes Tebra to silently return 0 results.
        // PatientState is instead resolved via a separate GetServiceLocations call.
      '</ns:Fields>' +
      '<ns:Filter>' +
        '<ns:StartDate>' + startTebra + '</ns:StartDate>' +
        '<ns:EndDate>'   + endTebra   + '</ns:EndDate>'   +
      '</ns:Filter>' +
    '</ns:request></ns:GetAppointments>';

  var text = _tebraPost('GetAppointments', bodyXml);

  var doc  = XmlService.parse(text);
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
    'cancelled':   1, 'canceled':   1,
    'deleted':     1,
    'no show':     1, 'noshow':     1, 'no-show': 1,
    'rescheduled': 1                       // moved to a new slot — don't duplicate
  };

  return apptEls.map(function(el) {
    var fullName        = _findFirstXml(el, 'PatientFullName');
    var rawStart        = _findFirstXml(el, 'StartDate');
    var tebraId         = _findFirstXml(el, 'ID');
    var resourceName1   = _findFirstXml(el, 'ResourceName1');
    var status          = _findFirstXml(el, 'ConfirmationStatus');
    var insurance       = _findFirstXml(el, 'PatientCaseName');
    var serviceLocation = _findFirstXml(el, 'ServiceLocationName');
    var serviceLocId    = _findFirstXml(el, 'ServiceLocationID');

    var parsed      = _parseTebraStartDate(rawStart);
    // Match by provider name (ResourceName1) — more reliable than ResourceID
    var crbProv     = _matchTebraProvider(resourceName1);
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
      provID:          crbProv,
      date:            parsed.date,
      time:            parsed.time,
      patient:         patientName,
      tebraStatus:     status,
      tebraApptId:     tebraId,
      insurance:       insurance,           // primary insurance carrier from Tebra
      serviceLocation: serviceLocation,     // e.g. "Colorado - Solrei Behavioral Health, Inc."
      serviceLocId:    serviceLocId,        // numeric Tebra service location ID (fallback lookup)
      resourceName1:   resourceName1,       // kept for diagnostic logging
      _invalid:        _invalid,
      _statusOnly:     _statusOnly,
    };
  }).filter(function(a) {
    if (a._invalid) {
      var isPlaceholder = PLACEHOLDER_PATIENT_NAMES.indexOf((a.patient || '').toUpperCase()) !== -1;
      Logger.log(isPlaceholder
        ? '  Skipping placeholder calendar block: ' + a.patient + ' on ' + a.date
        : '  Invalid (unmapped provider "' + (a.resourceName1||'?') + '" / no name): ' + a.patient + ' on ' + a.date);
      return false;
    }
    if (!a.patient || !a.date || !a.time) {
      Logger.log('  Skipping incomplete: ' + JSON.stringify(a));
      return false;
    }
    // Keep status-only records — they still go to importFromTebraApi for existing-row updates
    if (a._statusOnly) {
      Logger.log('  Status-only [' + a.provID + '/' + a.tebraStatus + ']: ' +
                 a.patient + ' on ' + a.date);
    }
    return true;
  });
}

function _fetchTebraAppointmentsChunked(c, startDateStr, endDateStr) {
  var all      = [];
  var seenKeys = {};
  var tz       = Session.getScriptTimeZone();

  var chunkStart = _parseYMD(startDateStr);
  var rangeEnd   = _parseYMD(endDateStr);

  while (chunkStart <= rangeEnd) {
    var chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    if (chunkEnd > rangeEnd) chunkEnd = new Date(rangeEnd);

    var sStr = Utilities.formatDate(chunkStart, tz, 'yyyy-MM-dd');
    var eStr = Utilities.formatDate(chunkEnd,   tz, 'yyyy-MM-dd');
    Logger.log('  → Chunk: ' + sStr + ' – ' + eStr);

    var chunk = _fetchTebraAppointments(c, sStr, eStr);
    Logger.log('    Got ' + chunk.length + ' appointments in this chunk.');

    chunk.forEach(function(a) {
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
    dryRun     = !!dryRun;

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

    var allAppts   = [];
    var errors     = [];
    var provResult = {};

    // Fetch service location → state map (GetServiceLocations, non-fatal).
    // Builds "Colorado - Solrei Behavioral Health, Inc." → "CO" etc.
    var svcLocMap = _fetchServiceLocationMap(c);

    try {
      allAppts = _fetchTebraAppointmentsChunked(c, startDateStr, endDateStr);
      allAppts.forEach(function(a) {
        provResult[a.provID] = (provResult[a.provID] || 0) + 1;
        if (!a.patientState) {
          // Try map lookup first (by name, then by ID), then direct parse as fallback
          a.patientState = (a.serviceLocation && svcLocMap.nameToState[a.serviceLocation])
                        || (a.serviceLocId    && svcLocMap.idToState[a.serviceLocId])
                        || _extractStateFromLocationName(a.serviceLocation || '')
                        || '';
        }
      });
      var withState = allAppts.filter(function(a) { return !!a.patientState; }).length;
      Logger.log('📍 PatientState resolved: ' + withState + '/' + allAppts.length + ' appointments');
    } catch (fetchErr) {
      errors.push(fetchErr.message);
      Logger.log('❌  _fetchTebraAppointmentsChunked error: ' + fetchErr.message);
    }

    var COL_APPTID     = APPT_COLS.indexOf('ApptID');
    var COL_DATE       = APPT_COLS.indexOf('Date');
    var COL_NOTES      = APPT_COLS.indexOf('Notes');
    var COL_STATUS     = APPT_COLS.indexOf('Status');
    var COL_LMOD       = APPT_COLS.indexOf('LastModified');
    var COL_MODBY      = APPT_COLS.indexOf('ModifiedBy');
    var NUM_COLS       = APPT_COLS.length;
    var COL_DIRECT_INS = APPT_COLS.indexOf('DirectIns') + 1; // 1-based sheet column (M)
    var COL_TS_0BASED  = APPT_COLS.indexOf('TebraStatus'); // 0-based — used by _findStaleRows'
                                                            // idempotency check below, ahead of
                                                            // the 1-based COL_TEBRA_STATUS declared
                                                            // later for the main update loop.

    var activeTebraIds = {};
    var activeSlotKeys = {};   // provID||date||normalizedTime — same key format as the
                               // main update loop below, so ID reassignment by Tebra
                               // doesn't cause a false "stale" flag (see _findStaleRows).
    var canReconcile   = errors.length === 0;
    if (canReconcile) {
      allAppts.forEach(function(a) {
        if (a.tebraApptId) activeTebraIds[String(a.tebraApptId)] = true;
        activeSlotKeys[a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time)] = true;
      });
    }

    var COL_PROV_ID = APPT_COLS.indexOf('ProvID');
    var COL_TIME    = APPT_COLS.indexOf('Time');

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
    function _findStaleRows(dataBlock) {
      var stale = [];
      if (!canReconcile || !dataBlock || !dataBlock.length) return stale;

      var ID_RE = /\(ID:(\d+)\)/;
      dataBlock.forEach(function(row, i) {
        var apptId = String(row[COL_APPTID] || '');
        if (apptId.indexOf('TEBRA-API-') !== 0) return;

        var rowDate = _fmtDate(row[COL_DATE]);
        if (rowDate < startDateStr || rowDate > endDateStr) return;

        var match = String(row[COL_NOTES] || '').match(ID_RE);
        if (!match) return;

        var tebraId = match[1];
        // Idempotency: skip rows already flagged by a previous sync run —
        // now checked on Column AI (TebraStatus), not Column Y (Status),
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
          patient:  String(row[APPT_COLS.indexOf('Patient')] || ''),
          date:     rowDate,
          tebraId:  tebraId,
          sheetRow: i + 2,
        });
      });
      return stale;
    }

    if (dryRun) {
      var ss        = SpreadsheetApp.getActiveSpreadsheet();
      var apptSheet = ss.getSheetByName(TAB_APPT);

      Logger.log('DRY RUN — ' + allAppts.length + ' appointments from Tebra API.');
      allAppts.forEach(function(a) {
        Logger.log('  [' + a.provID + '] ' + a.date + '  ' + a.time + '  — ' + a.patient);
      });

      var dryRunBlock = (apptSheet && apptSheet.getLastRow() > 1)
        ? apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, NUM_COLS).getValues()
        : [];
      var wouldFlag = _findStaleRows(dryRunBlock);
      if (wouldFlag.length) {
        Logger.log('Would flag ' + wouldFlag.length + ' stale appointments as "Deleted in Tebra" (TebraStatus, Column AI):');
        wouldFlag.forEach(function(s) {
          Logger.log('  ⚠️  ' + s.patient + ' on ' + s.date + ' (Tebra ID ' + s.tebraId + ')');
        });
      }

      return JSON.stringify({
        dryRun:       true,
        parsed:       allAppts.length,
        appointments: allAppts,
        providers:    provResult,
        wouldFlag:    wouldFlag,
        errors:       errors,
      });
    }

    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    if (!apptSheet) {
      return JSON.stringify({
        error: 'Appointments sheet not found — run initializeSheets() first.'
      });
    }

    var patientLookup = _buildPatientLookup(ss);
    Logger.log('Patient lookup: ' + Object.keys(patientLookup).length + ' patients');

    var existingRowMap       = {};
    var existingTSMap        = {};   // rowNum → current TebraStatus in sheet (for logging)
    var existingSignedMap    = {};   // rowNum → current Signed boolean in sheet (for auto-reconcile)
    var existingPatientSet   = {};   // lowercase patient name → true (has ≥1 appointment row)
    var existingPatientByRow = {};   // rowNum → lowercase patient name in that row
    var COL_TEBRA_STATUS  = APPT_COLS.indexOf('TebraStatus') + 1; // 1-based sheet column
    var COL_SIGNED        = APPT_COLS.indexOf('Signed') + 1;      // 1-based sheet column (Z)

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

    apptData.forEach(function(r, i) {
      var key    = r[0] + '||' + _fmtDate(r[1]) + '||' + _normalizeTimeKey(r[3]);
      var rowNum = i + 2; // 1-based sheet row (row 1 = header)
      existingRowMap[key] = rowNum;
      // Track patient name per row (for slot-conflict detection below)
      // and per name (for _statusOnly new-patient check).
      var ptName = String(r[4] || '').toLowerCase().replace(/\s+/g, ' ').trim(); // col E = Patient
      if (ptName) {
        existingPatientSet[ptName]   = true;
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
    //   Check-out (10) > Scheduled (8) > Confirmed (7) > In Office (6)
    //   > No Show (3) > Rescheduled (2) > Cancelled/Deleted (1/0)
    var _STATUS_PRI = {
      'check-out': 10, 'checkout': 10, 'checked out': 10, 'checkedout': 10,
      'scheduled': 8,
      'confirmed': 7,
      'in office': 6, 'inoffice': 6,
      'no show': 3, 'noshow': 3, 'no-show': 3,
      'rescheduled': 2,
      'cancelled': 1, 'canceled': 1,
      'deleted': 0
    };
    function _sPri(s) { return _STATUS_PRI[(s || '').toLowerCase().trim()] || 4; }

    var _dedupeMap  = {};  // "provID||date||time||patientNorm" → index in dedupedAppts
    var dedupedAppts = [];
    allAppts.forEach(function(a) {
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

    var imported          = 0;
    var skipped           = 0;
    var statusUpdated     = 0;
    var insuranceUpdated  = 0;
    var autoSigned        = 0;   // rows auto-flipped to Signed=TRUE because TebraStatus = Checked Out
    var newPatientsMap    = {};   // key: lowercase full name → { firstName, lastName, insurance }

    // ── PERFORMANCE: new appointment rows are collected here and written in
    // ONE batched setValues() call after the loop, instead of one
    // setValues() + one setNumberFormat() call per row as before.
    var newRowsData    = [];
    var firstNewRowNum = apptSheet.getLastRow() + 1;
    var nextNewRowNum  = firstNewRowNum;

    dedupedAppts.forEach(function(appt) {
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
            lastName:  _pts.slice(1).join(' ') || '',
            insurance: appt.insurance || '',
          };
        } else if (appt.insurance && !newPatientsMap[_ptNameLower].insurance) {
          // Prefer the first insurance value we encounter
          newPatientsMap[_ptNameLower].insurance = appt.insurance;
        }
      }
      // ─────────────────────────────────────────────────────────────────

      if (existingRowMap.hasOwnProperty(key)) {
        var rowNum  = existingRowMap[key];
        var rowIdx  = rowNum - 2; // index into apptData

        // ── Slot-conflict guard ──────────────────────────────────────────────
        // If the existing row belongs to a DIFFERENT patient, a previous patient
        // was rescheduled out of this slot and a NEW patient now occupies it.
        // Do NOT update the old row with the new patient's status; instead fall
        // through to create a fresh row for the new patient.
        // Normalize whitespace so "John  Smith" and "John Smith" don't
        // falsely trigger a slot-conflict and create a duplicate row.
        var existingPtInRow = (existingPatientByRow[rowNum] || '').replace(/\s+/g, ' ').trim();
        var incomingPt      = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
        // Use _samePatient() instead of strict equality so that middle-name variants
        // ("Jane Smith" vs "Jane M Smith") are treated as the same person rather than
        // triggering a false slot-conflict that creates a duplicate row.
        if (existingPtInRow && incomingPt && !_samePatient(existingPtInRow, incomingPt)) {
          Logger.log('  ⚡ Slot conflict on ' + appt.date + ' ' + appt.time +
                     ' [' + appt.provID + ']: sheet has "' + existingPtInRow +
                     '" but Tebra has "' + incomingPt + '" — creating new row');
          // Fall through to row creation below (do NOT return here)
        } else {
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

          // ── DirectIns: overwrite with Tebra's primary insurance carrier (PatientCaseName).
          if (appt.insurance && COL_DIRECT_INS > 0) {
            apptData[rowIdx][COL_DIRECT_INS - 1] = appt.insurance;
            insuranceUpdated++;
            touched = true;
          }

          // ── PatientState: stamp from Patients tab (primary source), only if
          // currently blank. Read directly from the in-memory block — no
          // separate getRange().getValue() round-trip needed anymore.
          var COL_PT_STATE  = APPT_COLS.indexOf('PatientState') + 1; // 1-based
          var _ptLookupInfo = patientLookup[(appt.patient || '').toLowerCase()] || {};
          var _stateToWrite = appt.patientState || _ptLookupInfo.patientState || '';
          if (_stateToWrite && COL_PT_STATE > 0) {
            var existingState = String(apptData[rowIdx][COL_PT_STATE - 1] || '').trim();
            if (!existingState) {
              apptData[rowIdx][COL_PT_STATE - 1] = _stateToWrite;
              touched = true;
            }
          }

          if (!touched) skipped++;
          return;
        }
        // ── End slot-conflict guard (fall-through means: create new row below) ──
      }

      // Don't create a new row for cancelled / no-show / deleted appointments —
      // UNLESS this patient has no appointment rows yet (brand-new or never synced).
      // We check existingPatientSet (built from the Appointments sheet) rather than
      // patientLookup (built from the Patients tab), because a patient can exist in
      // the Patients tab from a previous run but still have zero appointment rows.
      if (appt._statusOnly) {
        var _ptKey      = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
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

      var ptInfo   = patientLookup[(appt.patient || '').toLowerCase()] || {};
      // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
      var method   = ptInfo.method || '';
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
        id:               apptId,
        time:             appt.time,
        patient:          appt.patient,
        method:           method,
        alma:             { text: '', valid: null },
        hw:               { text: '', valid: null },
        grow:             { text: '', valid: null },
        directIns:        directInsValue,
        intake:           null,
        ins:              null,
        autopay:          null,
        scr:              { 'PHQ-9': null, 'GAD-7': null, 'PCL-5': null },
        ccEhr:            '',
        notes:            'Imported from Tebra API' +
                          (appt.tebraApptId ? ' (ID:' + appt.tebraApptId + ')' : ''),
        unsigned:         [],
        cpt:              [],
        billing:          'pending',
        status:           'pending',
        out:              false,
        paymentType:      isDirect ? (ptInfo.patientPortion || '') : '',
        paymentRate:      isDirect ? (ptInfo.rate           || '') : '',
        paymentAmount:    '',
        paymentCollected: false,
        paymentFailed:    false,
        comms:            [],
        tebraStatus:      appt.tebraStatus || '',
        insuranceCarrier: directInsValue,
        patientState:     patientStateValue,
      }, appt.provID, appt.date);

      var newRow = nextNewRowNum;
      nextNewRowNum++;
      newRowsData.push(rowData);

      existingRowMap[key] = newRow;
      // Register new patient in tracking maps so any subsequent Tebra records
      // for the same slot can correctly identify the patient in the new row.
      var _ptKeyNew = (appt.patient || '').toLowerCase().replace(/\s+/g, ' ').trim();
      existingPatientByRow[newRow] = _ptKeyNew;
      existingTSMap[newRow]        = appt.tebraStatus || '';
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
    var staleRows = _findStaleRows(apptData);
    var flagged   = 0;
    var now       = new Date().toISOString();

    staleRows.forEach(function(s) {
      var rowIdx = s.sheetRow - 2;
      if (COL_TEBRA_STATUS > 0) {
        apptData[rowIdx][COL_TEBRA_STATUS - 1] = 'Deleted in Tebra';
      }
      apptData[rowIdx][COL_LMOD]   = now;
      apptData[rowIdx][COL_MODBY]  = 'Tebra Sync';
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

    // ── PERFORMANCE: ONE batched write for every brand-new appointment row,
    // instead of one setValues() + one setNumberFormat() call per row.
    if (newRowsData.length) {
      var rowWidth = newRowsData[0].length;
      apptSheet.getRange(firstNewRowNum, 1, newRowsData.length, rowWidth).setValues(newRowsData);
      apptSheet.getRange(firstNewRowNum, 4, newRowsData.length, 1).setNumberFormat('@');
    }

    // ── Add brand-new patients to Patients tab ────────────────────────
    // Any patient whose appointment was just imported but who had no record
    // in the Patients tab gets a new row created here so they appear in
    // autocomplete, patient search, and future lookups. Batched into one
    // setValues() call instead of one appendRow() per patient.
    var patientsCreated = 0;
    var patSheet        = ss.getSheetByName(TAB_PATIENT);

    var newPatientKeys = Object.keys(newPatientsMap);
    if (patSheet && newPatientKeys.length > 0) {
      var newPatientRows = [];
      newPatientKeys.forEach(function(nameLower) {
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
        patientsCreated++;

        // Add to in-memory lookup so the insurance-update pass below can find them.
        // Blank, not 'hw' — matches the blank Platform just written above; the
        // biller sets the real channel via Billing Channels in SolBoard, and
        // unknown appointments show as unselected rather than defaulting to
        // Headway (Solrei brand rule).
        patientLookup[nameLower] = {
          method:         '',
          insurance:      pt.insurance,
          patientPortion: '',
          rate:           '',
        };

        Logger.log('  ✅ Added to Patients tab: ' + pt.firstName + ' ' + pt.lastName +
                   (pt.insurance ? ' (Ins: ' + pt.insurance + ')' : ''));
      });
      if (newPatientRows.length) {
        var patStartRow = patSheet.getLastRow() + 1;
        patSheet.getRange(patStartRow, 1, newPatientRows.length, 6).setValues(newPatientRows);
      }
    }
    // ─────────────────────────────────────────────────────────────────

    // ── Update Patients tab Insurance column from Tebra ──────────────
    // Build a map of patient name → most recently seen PatientCaseName
    // across all appointments returned in this sync window. Batched into
    // one setValues() call instead of one setValue() per updated patient.
    var patientInsuranceMap = {};
    allAppts.forEach(function(a) {
      if (a.insurance && a.patient) {
        patientInsuranceMap[a.patient.toLowerCase()] = a.insurance;
      }
    });

    var patientsUpdated = 0;
    var COL_PT_FNAME    = PATIENT_COLS.indexOf('FirstName');       // 0-based
    var COL_PT_LNAME    = PATIENT_COLS.indexOf('LastName');        // 0-based
    var COL_PT_INS      = PATIENT_COLS.indexOf('InsuranceCarrier'); // 0-based — in-memory mutation

    if (patSheet && patSheet.getLastRow() > 1 &&
        Object.keys(patientInsuranceMap).length > 0) {

      var ptLastRow = patSheet.getLastRow();
      var ptData    = patSheet.getRange(2, 1, ptLastRow - 1, PATIENT_COLS.length).getValues();
      var ptTouched = false;

      ptData.forEach(function(row, i) {
        var first    = String(row[COL_PT_FNAME] || '').trim();
        var last     = String(row[COL_PT_LNAME] || '').trim();
        if (!first && !last) return;

        var fullName = _titleCase(first + ' ' + last).toLowerCase();
        var ins      = patientInsuranceMap[fullName];
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
      imported:          imported,
      patientsCreated:   patientsCreated,
      statusUpdated:     statusUpdated,
      insuranceUpdated:  insuranceUpdated,
      patientsUpdated:   patientsUpdated,
      autoSigned:        autoSigned,
      skipped:           skipped,
      flagged:           flagged,
      total:             allAppts.length,
      providers:         provResult,
      errors:            errors,
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
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var patSheet  = ss.getSheetByName(TAB_PATIENT);
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!patSheet || !apptSheet) { Logger.log('❌  Sheet not found.'); return; }

  // ── Read ALL patient data (header + rows) and resolve column indices from header
  var ptAll = patSheet.getDataRange().getValues();
  if (ptAll.length < 2) { Logger.log('No patient rows.'); return; }
  var ptHdr = ptAll[0].map(function(h) { return String(h || '').trim(); });
  var COL_PT_FNAME = ptHdr.indexOf('FirstName');    if (COL_PT_FNAME < 0) COL_PT_FNAME = 0;
  var COL_PT_LNAME = ptHdr.indexOf('LastName');     if (COL_PT_LNAME < 0) COL_PT_LNAME = 1;
  var COL_PT_STATE = ptHdr.indexOf('PatientState'); if (COL_PT_STATE < 0) COL_PT_STATE = 12;
  Logger.log('backfillPatientStatesFromTab: PatientState column in Patients tab = index ' +
             COL_PT_STATE + ' (header: "' + ptHdr[COL_PT_STATE] + '")');

  // ── Build name → state map; only include valid 2-letter state codes
  var stateMap = {};
  var badValues = 0;
  ptAll.slice(1).forEach(function(r) {
    var first = String(r[COL_PT_FNAME] || '').trim();
    var last  = String(r[COL_PT_LNAME] || '').trim();
    var raw   = String(r[COL_PT_STATE] || '').trim();
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
  var COL_APPT_STATE   = APPT_COLS.indexOf('PatientState');  // 0-based
  if (COL_APPT_PATIENT < 0 || COL_APPT_STATE < 0) {
    Logger.log('❌  Patient or PatientState column missing from APPT_COLS.'); return;
  }

  var lastRow  = apptSheet.getLastRow();
  if (lastRow < 2) { Logger.log('No appointment rows.'); return; }

  var readCols = Math.max(COL_APPT_PATIENT, COL_APPT_STATE) + 1;
  var apptData = apptSheet.getRange(2, 1, lastRow - 1, readCols).getValues();
  var colState1 = COL_APPT_STATE + 1; // 1-based for setValues

  var updated = 0;
  apptData.forEach(function(r, i) {
    if (String(r[COL_APPT_STATE] || '').trim()) return; // already filled — skip
    var name  = String(r[COL_APPT_PATIENT] || '').trim().toLowerCase();
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
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!apptSheet || apptSheet.getLastRow() < 2) {
    Logger.log('cleanBadPatientStates: No appointment rows found.'); return;
  }

  var COL_APPT_STATE = APPT_COLS.indexOf('PatientState'); // 0-based
  if (COL_APPT_STATE < 0) {
    Logger.log('❌  PatientState column not found in APPT_COLS.'); return;
  }

  var lastRow   = apptSheet.getLastRow();
  var stateCol1 = COL_APPT_STATE + 1; // 1-based
  var stateVals = apptSheet.getRange(2, stateCol1, lastRow - 1, 1).getValues();
  var cleared   = 0;
  var kept      = 0;

  stateVals.forEach(function(row, i) {
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
  var lookup  = {};
  var PLATFORM_TO_METHOD = {
    'alma': 'alma', 'headway': 'hw', 'grow': 'grow', 'direct': 'direct'
  };
  var patSheet = ss.getSheetByName(TAB_PATIENT);
  if (patSheet && patSheet.getLastRow() > 1) {
    var allRows = patSheet.getDataRange().getValues();
    // ── Resolve column indices from actual header row so the lookup is robust
    //    even if PATIENT_COLS and the physical sheet columns have drifted apart.
    var hdr = allRows[0].map(function(h) { return String(h || '').trim(); });
    function col(name, fallback) {
      var idx = hdr.indexOf(name);
      return idx >= 0 ? idx : fallback;
    }
    var C_FIRST   = col('FirstName',        0);
    var C_LAST    = col('LastName',          1);
    var C_PLAT    = col('BillingChannel',    2);
    var C_INS     = col('InsuranceCarrier',  3);
    var C_PORTION = col('CostShareClass',    4);
    var C_RATE    = col('Rate',              5);
    var C_CLMPLAT = col('ClaimGateway',      6);
    var C_MEMID   = col('MemberID',          7);
    var C_DOB     = col('MemberDOB',         8);
    var C_PCN     = col('PCN',               9);
    var C_GROUP   = col('GroupNumber',      10);
    var C_SUBSCR  = col('PrimarySubscriber',11);
    var C_STATE   = col('PatientState',     12);
    var C_RNPI    = col('RenderingNPI',     13);
    var C_BNPI    = col('BillingNPI',       14);
    var C_XCODE   = col('xCode',            15);

    allRows.slice(1).forEach(function(r) {
        var first    = String(r[C_FIRST] || '').trim();
        var last     = String(r[C_LAST]  || '').trim();
        if (!first && !last) return;
        var fullName = (first + ' ' + last).trim().toLowerCase();
        var platform = String(r[C_PLAT]  || '').trim().toLowerCase();
        var rawState = String(r[C_STATE] || '').trim().toUpperCase();
        lookup[fullName] = {
          // Unknown/blank platform → blank Method, NOT a Headway default (Solrei brand rule).
          method:             PLATFORM_TO_METHOD[platform] || '',
          insurance:          String(r[C_INS]     || '').trim(),
          patientPortion:     String(r[C_PORTION] || '').trim(),
          rate:               _sv(r[C_RATE]).trim(),   // _sv preserves numeric 0 ($0 copay)
          claimPlatform:      String(r[C_CLMPLAT] || '').trim(),
          memberID:           String(r[C_MEMID]   || '').trim(),
          // Sheets stores manually-entered dates as Date objects; convert to YYYY-MM-DD
          memberDOB:          r[C_DOB] instanceof Date
                                ? Utilities.formatDate(r[C_DOB], Session.getScriptTimeZone(), 'yyyy-MM-dd')
                                : String(r[C_DOB]  || '').trim(),
          pcn:                String(r[C_PCN]    || '').trim(),
          groupNumber:        String(r[C_GROUP]  || '').trim(),
          primarySubscriber:  String(r[C_SUBSCR] || '').trim(),
          // Only store the state if it's a real 2-letter US state code —
          // guards against PrimarySubscriber or other data appearing in this cell.
          patientState:       _isValidUSState(rawState) ? rawState : '',
          renderingNPI:       String(r[C_RNPI]   || '').trim(),
          billingNPI:         String(r[C_BNPI]   || '').trim(),
          xCode:              String(r[C_XCODE]  || '').trim(),
        };
      });
  }
  return lookup;
}


function repairTimeColumn() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheet     = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('Nothing to repair.');
    return;
  }

  var TIME_COL  = APPT_COLS.indexOf('Time') + 1;
  var lastRow   = sheet.getLastRow();
  var timeRange = sheet.getRange(2, TIME_COL, lastRow - 1, 1);
  var values    = timeRange.getValues();

  var fixed = 0;
  var fixed_values = values.map(function(row) {
    var v    = row[0];
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


function clearTebraApiImports() {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var apptSheet = ss.getSheetByName(TAB_APPT);
  if (!apptSheet || apptSheet.getLastRow() < 2) {
    Logger.log('Nothing to clear.');
    return;
  }

  var APPT_ID_COL = APPT_COLS.indexOf('ApptID') + 1;
  var lastRow = apptSheet.getLastRow();
  var ids = apptSheet.getRange(2, APPT_ID_COL, lastRow - 1, 1).getValues();

  var rowsToDelete = [];
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).indexOf('TEBRA-API-') === 0) {
      rowsToDelete.push(i + 2);
    }
  }

  if (rowsToDelete.length === 0) {
    Logger.log('No TEBRA-API rows found.');
    return;
  }

  rowsToDelete.forEach(function(rowNum) {
    apptSheet.deleteRow(rowNum);
  });

  SpreadsheetApp.flush();
  Logger.log('✅  Deleted ' + rowsToDelete.length + ' TEBRA-API import rows.');
  _audit(ss, 'TEBRA_API_CLEAR',
    'Cleared ' + rowsToDelete.length + ' TEBRA-API imported rows.');
}


function runTebraApiImportToday() {
  var today = Utilities.formatDate(
    new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  Logger.log('Importing TODAY (' + today + ') from Tebra API...');
  var result = JSON.parse(importFromTebraApi(today, today, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

/**
 * DIAGNOSTIC — run this from Apps Script editor.
 * Imports only 2026-05-12 and logs every decision for appointments
 * that don't have an existing row, so we can see why any are skipped.
 */
function debugImportMay12() {
  Logger.log('=== DEBUG IMPORT: 2026-05-12 only ===');
  var result = JSON.parse(importFromTebraApi('2026-05-12', '2026-05-12', false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
  Logger.log('If imported=0 and no errors, check log above for ↻ and ⚠ lines.');
}

function runTebraApiImportThisWeek() {
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  var dow   = today.getDay();
  var mon = new Date(today);
  mon.setDate(today.getDate() - ((dow + 6) % 7));
  var sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  var startStr = Utilities.formatDate(mon, tz, 'yyyy-MM-dd');
  var endStr   = Utilities.formatDate(sun, tz, 'yyyy-MM-dd');

  Logger.log('Importing week ' + startStr + ' – ' + endStr + ' from Tebra API...');
  var result = JSON.parse(importFromTebraApi(startStr, endStr, false));
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
}

function runTebraApiImportEightWeeks() {
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  var dow   = today.getDay();

  var lastMon = new Date(today);
  lastMon.setDate(today.getDate() - ((dow + 6) % 7) - 7);

  var eightWeeksOut = new Date(lastMon);
  eightWeeksOut.setDate(lastMon.getDate() + 55);

  var startStr = Utilities.formatDate(lastMon,        tz, 'yyyy-MM-dd');
  var endStr   = Utilities.formatDate(eightWeeksOut,  tz, 'yyyy-MM-dd');

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
  var tz    = Session.getScriptTimeZone();
  var today = new Date();

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

  var DAYS_BACK    = 14;  // 2 weeks back
  var DAYS_FORWARD = 28;  // 4 weeks forward

  var tz    = Session.getScriptTimeZone();
  var today = new Date();

  var start = new Date(today); start.setDate(today.getDate() - DAYS_BACK);
  var end   = new Date(today); end.setDate(today.getDate() + DAYS_FORWARD);

  var startStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
  var endStr   = Utilities.formatDate(end,   tz, 'yyyy-MM-dd');

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
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
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

  var NUM_COLS    = APPT_COLS.length;
  var PROV_IDX    = APPT_COLS.indexOf('ProvID');    // 0
  var DATE_IDX    = APPT_COLS.indexOf('Date');      // 1
  var TIME_IDX    = APPT_COLS.indexOf('Time');      // 3
  var PATIENT_IDX = APPT_COLS.indexOf('Patient');   // 4

  // Read all data rows (row 1 is the header)
  var allData = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();

  // ── Build slot groups ────────────────────────────────────────────────────
  // Key: "provID||YYYY-MM-DD||HH:MM"
  // Value: array of { rowNum (1-based), data, ptNorm (stripped first+last) }
  var slotGroups = {};

  allData.forEach(function(row, i) {
    var provID  = String(row[PROV_IDX]    || '').trim();
    var dateStr = _fmtDate(row[DATE_IDX]);
    var timeStr = _normalizeTimeKey(row[TIME_IDX]);
    var patient = String(row[PATIENT_IDX] || '').trim();

    if (!provID || !dateStr) return; // skip completely blank rows

    var slotKey = provID + '||' + dateStr + '||' + timeStr;
    // Strip middle name and lowercase for comparison
    var ptNorm  = _stripMiddleName(patient).toLowerCase().replace(/\s+/g, ' ').trim();

    if (!slotGroups[slotKey]) slotGroups[slotKey] = [];
    slotGroups[slotKey].push({ rowNum: i + 2, data: row, ptNorm: ptNorm });
  });

  // ── Score function: prefer rows with more important fields filled in ──────
  var SCORE_COLS = [
    APPT_COLS.indexOf('Signed'),
    APPT_COLS.indexOf('CPTCodes'),
    APPT_COLS.indexOf('TebraStatus'),
    APPT_COLS.indexOf('Notes'),
    APPT_COLS.indexOf('BillingChannel'),
    APPT_COLS.indexOf('ApptID'),
    APPT_COLS.indexOf('ClaimStatus'),
    APPT_COLS.indexOf('ClaimPaidAmount'),
    APPT_COLS.indexOf('NoteStatus'),
  ].filter(function(idx) { return idx >= 0; });

  function _scoreRow(data) {
    var score = 0;
    SCORE_COLS.forEach(function(idx) {
      var v = data[idx];
      if (v !== undefined && v !== null && v !== '' && v !== false) score++;
    });
    return score;
  }

  // ── Find duplicates and decide which rows to delete ───────────────────────
  var rowsToDelete = []; // 1-based row numbers

  Object.keys(slotGroups).forEach(function(slotKey) {
    var entries = slotGroups[slotKey];
    if (entries.length < 2) return; // no duplicates in this slot

    // Sub-group entries by their normalized patient name.
    // Entries with the same first+last (ignoring middle names) are duplicates.
    var ptGroups = {};
    entries.forEach(function(e) {
      var k = e.ptNorm || '__empty__';
      if (!ptGroups[k]) ptGroups[k] = [];
      ptGroups[k].push(e);
    });

    Object.keys(ptGroups).forEach(function(ptKey) {
      var group = ptGroups[ptKey];
      if (group.length < 2) return; // only one row for this patient — fine

      // Sort best-row first (highest score = most data filled in)
      group.sort(function(a, b) { return _scoreRow(b.data) - _scoreRow(a.data); });

      var best = group[0];
      Logger.log('  🔀 Dup [' + slotKey + '] "' + ptKey + '"' +
                 ' → keep row ' + best.rowNum +
                 ' (score ' + _scoreRow(best.data) + ')' +
                 ', delete: ' + group.slice(1).map(function(e) { return e.rowNum; }).join(', '));

      group.slice(1).forEach(function(e) { rowsToDelete.push(e.rowNum); });
    });
  });

  if (rowsToDelete.length === 0) {
    Logger.log('✅ deduplicateAppointments: no duplicates found — sheet is clean.');
    return;
  }

  // Delete from bottom up so row numbers above each deletion stay valid
  rowsToDelete.sort(function(a, b) { return b - a; });
  Logger.log('🗑  Deleting ' + rowsToDelete.length + ' duplicate row(s): ' +
             rowsToDelete.join(', '));

  rowsToDelete.forEach(function(rowNum) { sheet.deleteRow(rowNum); });

  _audit(ss, 'DEDUP_APPOINTMENTS',
    'Removed ' + rowsToDelete.length + ' duplicate appointment row(s).');

  Logger.log('✅ deduplicateAppointments: done — removed ' + rowsToDelete.length + ' rows.');
}


function runTebraApiImportDryRunThisWeek() {
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  var dow   = today.getDay();
  var mon   = new Date(today);
  mon.setDate(today.getDate() - ((dow + 6) % 7));
  var sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);

  var startStr = Utilities.formatDate(mon, tz, 'yyyy-MM-dd');
  var endStr   = Utilities.formatDate(sun, tz, 'yyyy-MM-dd');

  Logger.log('DRY RUN — week ' + startStr + ' – ' + endStr);
  var result = JSON.parse(importFromTebraApi(startStr, endStr, true));
  Logger.log('Would import ' + result.parsed + ' appointments:');
  (result.appointments || []).forEach(function(a, i) {
    Logger.log('  ' + (i + 1) + '. [' + a.provID + '] ' +
               a.date + '  ' + a.time + '  — ' + a.patient);
  });
  if (result.wouldFlag && result.wouldFlag.length) {
    Logger.log('Would flag ' + result.wouldFlag.length + ' as "cancelled in tebra":');
    result.wouldFlag.forEach(function(s) {
      Logger.log('  ⚠️  ' + s.patient + ' on ' + s.date);
    });
  }
  if (result.errors && result.errors.length) {
    Logger.log('Errors: ' + JSON.stringify(result.errors));
  }
}

/**
 * Diagnostic — run this manually from Apps Script editor to see exactly
 * how column V is stored for a given patient. Run it AFTER clicking
 * Note Signed so you can see whether the sheet was written.
 *
 *   debugUnsignedNotes('Bob Boone');
 */
function debugUnsignedNotes(patientName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('No data.'); return; }

  var COL_DATE     = APPT_COLS.indexOf('Date') + 1;
  var COL_PATIENT  = APPT_COLS.indexOf('Patient') + 1;
  var COL_UNSIGNED = APPT_COLS.indexOf('UnsignedDates') + 1;
  var COL_SIGNED   = APPT_COLS.indexOf('Signed') + 1;

  var target = _normName(patientName);
  var data = sheet.getDataRange().getValues();
  var hits = 0;

  Logger.log('=== Unsigned-note diagnostic for "' + patientName + '" ===');
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (_normName(r[COL_PATIENT - 1]) !== target) continue;
    hits++;
    var raw = r[COL_UNSIGNED - 1];
    var typ = raw instanceof Date ? 'Date' : typeof raw;
    Logger.log(
      'Row ' + (i + 1) +
      ' | date=' + _fmtDate(r[COL_DATE - 1]) +
      ' | signed=' + r[COL_SIGNED - 1] +
      ' | V type=' + typ +
      ' | V raw=' + JSON.stringify(raw) +
      ' | V normalized=' + _normalizeDateStr(raw)
    );
  }
  if (!hits) Logger.log('No rows found for that patient. (Name must match exactly, case-insensitive.)');
}

/**
 * One-time cleanup — forces every cell in column V to text format and
 * converts any Date objects it finds into "M/D/YY" text. Safe to run
 * anytime; it never destroys data. Run it once after deploying this fix.
 */
/**
 * Diagnostic — run this to understand exactly why TebraStatus isn't
 * showing in the Provider window for a given provider + date.
 *
 * It does three things:
 *   1. Shows every sheet row for that provider+date, with their
 *      Time key and the raw value in column AI (TebraStatus).
 *   2. Fetches Tebra appointments for that date and shows each one's
 *      time key and confirmation status.
 *   3. Shows which sheet rows matched / didn't match Tebra entries.
 *
 * Usage (run from Apps Script editor):
 *   debugTebraStatusForProvider('jodene', '2026-05-08');
 */
function debugTebraStatusForProvider(provId, dateStr) {
  provId  = provId  || 'jodene';
  dateStr = dateStr || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('No data.'); return; }

  var TS_IDX   = APPT_COLS.indexOf('TebraStatus');  // 0-based
  var allRows  = sheet.getDataRange().getValues();
  var numCols  = allRows[0] ? allRows[0].length : 0;

  Logger.log('Sheet has ' + numCols + ' columns in data range. TebraStatus is at 0-based index ' + TS_IDX +
             ' (column ' + (TS_IDX + 1) + '). Data range ' + (numCols > TS_IDX ? 'INCLUDES' : 'DOES NOT INCLUDE') + ' it.');

  // ── 1. Sheet rows for this provider + date ───────────────────────
  Logger.log('\n── Sheet rows for [' + provId + '] on ' + dateStr + ' ──');
  var sheetRows = [];
  for (var i = 1; i < allRows.length; i++) {
    var r = allRows[i];
    if (String(r[0]) !== provId) continue;
    if (_fmtDate(r[1]) !== dateStr) continue;
    var timeKey  = _normalizeTimeKey(r[3]);
    var tebra    = numCols > TS_IDX ? String(r[TS_IDX] || '') : '(col out of range)';
    var patient  = String(r[4] || '');
    var sheetKey = provId + '||' + dateStr + '||' + timeKey;
    sheetRows.push({ patient: patient, time: String(r[3]), timeKey: timeKey, tebraStatus: tebra, sheetKey: sheetKey, rowNum: i + 1 });
    Logger.log('  Row ' + (i + 1) + '  ' + patient + '  time="' + r[3] + '" → key="' + timeKey + '"  TebraStatus="' + tebra + '"');
  }
  Logger.log('  Total sheet rows: ' + sheetRows.length);

  // ── 2. What Tebra returns for that date ──────────────────────────
  Logger.log('\n── Tebra appointments for ' + dateStr + ' ──');
  var c = _getTebraCreds();
  var tebraAppts = [];
  try {
    tebraAppts = _fetchTebraAppointments(c, dateStr, dateStr);
  } catch (e) {
    Logger.log('  Tebra fetch error: ' + e.message);
  }
  var tebraForProv = tebraAppts.filter(function(a) { return a.provID === provId; });
  Logger.log('  Tebra returned ' + tebraForProv.length + ' appointments for ' + provId + ':');
  tebraForProv.forEach(function(a) {
    var tebraKey = a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time);
    Logger.log('  ' + a.patient + '  time="' + a.time + '" → key="' + _normalizeTimeKey(a.time) + '"  status="' + a.tebraStatus + '"');
  });

  // ── 3. Match / no-match report ───────────────────────────────────
  Logger.log('\n── Match report ──');
  sheetRows.forEach(function(row) {
    var match = tebraForProv.find(function(a) {
      return (a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time)) === row.sheetKey;
    });
    if (match) {
      Logger.log('  ✅ MATCH  ' + row.patient + ' @ ' + row.timeKey + '  →  Tebra status="' + match.tebraStatus + '"  Sheet AI="' + row.tebraStatus + '"');
    } else {
      Logger.log('  ❌ NO MATCH for sheet row: ' + row.patient + ' @ ' + row.timeKey + '  (Sheet AI="' + row.tebraStatus + '")');
    }
  });
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

  var converted = values.map(function(row) {
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
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
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
    pRows.forEach(function(r, i) {
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
  var apptRows  = [];
  if (apptSheet && apptSheet.getLastRow() > 1) {
    var aData = apptSheet.getDataRange().getValues();
    var headers = aData[0];
    for (var i = 1; i < aData.length; i++) {
      var r = aData[i];
      var ptCell = String(r[APPT_COLS.indexOf('Patient')] || '').trim().toLowerCase();
      if (ptCell !== target) continue;
      apptRows.push({ rowNum: i + 1, data: r });
      var provID  = r[APPT_COLS.indexOf('ProvID')];
      var date    = _fmtDate(r[APPT_COLS.indexOf('Date')]);
      var time    = r[APPT_COLS.indexOf('Time')];
      var apptId  = r[APPT_COLS.indexOf('ApptID')];
      var status  = r[APPT_COLS.indexOf('Status')];
      var billing = r[APPT_COLS.indexOf('Billing')];
      var tebra   = r[APPT_COLS.indexOf('TebraStatus')];
      var notes   = r[APPT_COLS.indexOf('Notes')];
      Logger.log('  ✅ FOUND row ' + (i + 1) + ':');
      Logger.log('     ProvID="'      + provID  + '"');
      Logger.log('     Date="'        + date    + '"  (raw: ' + JSON.stringify(r[APPT_COLS.indexOf('Date')]) + ')');
      Logger.log('     Time="'        + time    + '"  key="' + _normalizeTimeKey(time) + '"');
      Logger.log('     ApptID="'      + apptId  + '"');
      Logger.log('     Status="'      + status  + '"');
      Logger.log('     Billing="'     + billing + '"');
      Logger.log('     TebraStatus="' + tebra   + '"');
      Logger.log('     Notes="'       + String(notes || '').substring(0, 80) + '"');
      var sheetKey = String(provID) + '||' + date + '||' + _normalizeTimeKey(time);
      Logger.log('     existingRowMap key="' + sheetKey + '"');
    }
  }
  if (apptRows.length === 0) Logger.log('  ❌ NOT found in Appointments tab');
  else Logger.log('  Total appointment rows: ' + apptRows.length);

  // ── 3. WHAT TEBRA CURRENTLY RETURNS ──────────────────────────────
  Logger.log('\n── 3. Tebra API (next 14 days) ──');
  var tz       = Session.getScriptTimeZone();
  var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 14);
  var futureStr = Utilities.formatDate(futureDate, tz, 'yyyy-MM-dd');
  var tebraMatches = [];
  try {
    var c = _getTebraCreds();
    var allTebra = _fetchTebraAppointments(c, todayStr, futureStr);
    allTebra.forEach(function(a) {
      if ((a.patient || '').toLowerCase() === target) {
        tebraMatches.push(a);
        var tebraKey = a.provID + '||' + a.date + '||' + _normalizeTimeKey(a.time);
        Logger.log('  ✅ FOUND in Tebra:');
        Logger.log('     patient="'      + a.patient      + '"');
        Logger.log('     provID="'       + a.provID       + '"');
        Logger.log('     date="'         + a.date         + '"');
        Logger.log('     time="'         + a.time         + '"  key="' + _normalizeTimeKey(a.time) + '"');
        Logger.log('     tebraStatus="'  + a.tebraStatus  + '"');
        Logger.log('     _statusOnly='   + a._statusOnly);
        Logger.log('     _invalid='      + a._invalid);
        Logger.log('     insurance="'    + a.insurance    + '"');
        Logger.log('     tebraKey="'     + tebraKey       + '"');

        // Does a matching sheet row exist?
        var matchedRow = apptRows.find(function(ar) {
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
  Logger.log('  In Patients tab:     ' + (inPatientsTab  ? 'YES' : 'NO'));
  Logger.log('  In Appointments tab: ' + (apptRows.length > 0 ? 'YES (' + apptRows.length + ' row(s))' : 'NO'));
  Logger.log('  Found in Tebra:      ' + (tebraMatches.length > 0 ? 'YES (' + tebraMatches.length + ' appt(s))' : 'NO'));
  Logger.log('══════════════════════════════════════════════');
}


/**
 * Convenience wrapper — edit the name here and run this function.
 * Change "Jane Smith" to the actual patient name, then click ▶ Run.
 */
function runDiagnoseNewPatient() {
  diagnoseNewPatient('Jane Smith');  // ← CHANGE THIS NAME
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
    var ss     = SpreadsheetApp.getActiveSpreadsheet();
    var sheet  = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: false, error: 'No patient sheet' });
    }

    var nameLower = (patientName || '').trim().toLowerCase();

    // ── Defensive header extension: ensure all PATIENT_COLS headers exist ──
    // This handles the case where the sheet was created before all columns were added.
    var headerRow = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
    PATIENT_COLS.forEach(function(col, idx) {
      if (headerRow.indexOf(col) === -1) {
        var targetCol = idx + 1;  // 1-based column position per PATIENT_COLS order
        // Ensure sheet has enough columns
        while (sheet.getMaxColumns() < targetCol) sheet.insertColumnAfter(sheet.getMaxColumns());
        var cell = sheet.getRange(1, targetCol);
        cell.setValue(col);
        cell.setBackground('#3D768A').setFontColor('#FBFBF3').setFontWeight('bold');
      }
    });

    var numCols   = Math.max(PATIENT_COLS.length, sheet.getLastColumn());
    var data      = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.min(numCols, sheet.getLastColumn()))
                        .getValues();

    var COL_CLAIM  = PATIENT_COLS.indexOf('ClaimGateway')       + 1;  // 1-based
    var COL_INS    = PATIENT_COLS.indexOf('InsuranceCarrier')   + 1;
    var COL_MEMID  = PATIENT_COLS.indexOf('MemberID')          + 1;
    var COL_DOB    = PATIENT_COLS.indexOf('MemberDOB')         + 1;
    var COL_PCN    = PATIENT_COLS.indexOf('PCN')               + 1;
    var COL_GROUP  = PATIENT_COLS.indexOf('GroupNumber')       + 1;
    var COL_SUB    = PATIENT_COLS.indexOf('PrimarySubscriber') + 1;
    var COL_STATE  = PATIENT_COLS.indexOf('PatientState')      + 1;
    var COL_RNPI   = PATIENT_COLS.indexOf('RenderingNPI')      + 1;
    var COL_BNPI   = PATIENT_COLS.indexOf('BillingNPI')        + 1;
    var COL_XCODE  = PATIENT_COLS.indexOf('xCode')             + 1;
    var COL_PPLAT  = PATIENT_COLS.indexOf('PaymentProcessingChannel') + 1;

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
      if (COL_CLAIM > 0) sheet.getRange(rowNum, COL_CLAIM).setValue(fields.claimPlatform    || '');
      if (COL_INS   > 0) sheet.getRange(rowNum, COL_INS  ).setValue(fields.insurance         || '');
      if (COL_SUB   > 0) sheet.getRange(rowNum, COL_SUB  ).setValue(fields.primarySubscriber || '');
      if (COL_STATE > 0) sheet.getRange(rowNum, COL_STATE).setValue(fields.patientState      || '');

      // Force plain text on DOB — prevents Sheets from re-interpreting YYYY-MM-DD as a date serial
      setPlainText(COL_DOB,   fields.memberDOB);

      // Force plain text on all code/ID fields — preserves leading zeros
      setPlainText(COL_MEMID, fields.memberID);
      setPlainText(COL_PCN,   fields.pcn);
      setPlainText(COL_GROUP, fields.groupNumber);
      setPlainText(COL_RNPI,  fields.renderingNPI);
      setPlainText(COL_BNPI,  fields.billingNPI);
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

/* ════════════════════════════════════════════════════════════════
   SAVE PATIENT BEST CHANNEL  — savePatientBestChannel
   Persists the CPT Dashboard best-channel recommendation for a
   patient into the BestChannel column (index 17) of the Patients
   tab.  Called when the biller clicks "Save as recommended channel"
   in the Claim Submit Modal's Best Channel badge.
   channelJson = { channel, payer, state, rate, cpts, updatedAt }
════════════════════════════════════════════════════════════════ */
function savePatientBestChannel(patientName, channelJson) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: false, error: 'No patient sheet' });
    }

    var nameLower = (patientName || '').trim().toLowerCase();
    var COL_BC    = PATIENT_COLS.indexOf('BestChannel') + 1;  // 1-based

    if (COL_BC < 1) {
      return JSON.stringify({ ok: false, error: 'BestChannel column not in PATIENT_COLS' });
    }

    // Ensure the header cell exists (auto-creates column if sheet is narrower than PATIENT_COLS)
    while (sheet.getMaxColumns() < COL_BC) sheet.insertColumnAfter(sheet.getMaxColumns());
    var hdrCell = sheet.getRange(1, COL_BC);
    if (!hdrCell.getValue()) {
      hdrCell.setValue('BestChannel');
      hdrCell.setBackground('#3D768A').setFontColor('#FBFBF3').setFontWeight('bold');
    }

    var numCols = Math.min(PATIENT_COLS.length, sheet.getLastColumn());
    var data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(numCols, 2)).getValues();

    for (var i = 0; i < data.length; i++) {
      var fullName = (String(data[i][0] || '') + ' ' + String(data[i][1] || '')).trim().toLowerCase();
      if (fullName !== nameLower) continue;

      var rowNum = i + 2;
      sheet.getRange(rowNum, COL_BC).setValue(channelJson || '');
      SpreadsheetApp.flush();
      _audit(ss, 'savePatientBestChannel', patientName + ' → ' + channelJson);
      Logger.log('savePatientBestChannel: row ' + rowNum + ' for "' + patientName + '"');
      return JSON.stringify({ ok: true, row: rowNum });
    }

    Logger.log('savePatientBestChannel: patient not found — "' + patientName + '"');
    return JSON.stringify({ ok: false, error: 'Patient not found: ' + patientName });
  } catch (e) {
    Logger.log('savePatientBestChannel error: ' + e.message);
    return JSON.stringify({ ok: false, error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   SET PATIENT BILLING CHANNEL  — setPatientBillingChannel
   Updates the BillingChannel column (index 2, formerly "Platform")
   on the Patients tab. This is the "going forward" claim-submission
   channel for a patient — NOT a retroactive edit of any
   already-created appointment row.

   Every night's Tebra Sync reads this value via _buildPatientLookup()
   / PLATFORM_TO_METHOD (internal helper name unchanged — see note above
   APPT_COLS on the scope of this terminology pass) and stamps it onto
   each *newly created* appointment row's BillingChannel column
   (Appointments tab, col F). Past appointment rows are untouched,
   matching Dean's "from the date going forward" requirement — the
   biller edits future routing here, and edits an individual past
   appointment's channel separately via the per-appointment channel
   selector in the Provider/Biller window.

   channel must be one of: '', 'Alma', 'Headway', 'Grow', 'Direct',
   'Unknown'. Blank and 'Unknown' are both accepted from the UI as
   "not yet determined" — both are normalized to '' on write, since
   PLATFORM_TO_METHOD already falls back to a blank BillingChannel
   for any value it doesn't recognize (Solrei brand rule: never default
   to Headway or any other channel).
════════════════════════════════════════════════════════════════ */
function setPatientBillingChannel(patientName, channel) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_PATIENT);
    if (!sheet || sheet.getLastRow() < 2) {
      return JSON.stringify({ ok: false, error: 'No patient sheet' });
    }

    var ALLOWED = ['Alma', 'Headway', 'Grow', 'Direct'];
    var raw     = String(channel || '').trim();
    var norm    = raw.toLowerCase() === 'unknown' ? '' : raw;
    if (norm && ALLOWED.indexOf(norm) === -1) {
      return JSON.stringify({ ok: false, error: 'Invalid billing channel: ' + channel });
    }

    var nameLower = (patientName || '').trim().toLowerCase();
    var COL_CHAN  = PATIENT_COLS.indexOf('BillingChannel') + 1;  // 1-based

    if (COL_CHAN < 1) {
      return JSON.stringify({ ok: false, error: 'BillingChannel column not in PATIENT_COLS' });
    }

    var numCols = Math.min(PATIENT_COLS.length, sheet.getLastColumn());
    var data    = sheet.getRange(2, 1, sheet.getLastRow() - 1, Math.max(numCols, 2)).getValues();

    for (var i = 0; i < data.length; i++) {
      var fullName = (String(data[i][0] || '') + ' ' + String(data[i][1] || '')).trim().toLowerCase();
      if (fullName !== nameLower) continue;

      var rowNum = i + 2;
      var prior  = String(data[i][2] || '').trim();
      sheet.getRange(rowNum, COL_CHAN).setValue(norm);
      SpreadsheetApp.flush();
      _audit(ss, 'setPatientBillingChannel', patientName + ': "' + (prior || '(blank)') + '" → "' + (norm || '(blank)') + '"');
      Logger.log('setPatientBillingChannel: row ' + rowNum + ' for "' + patientName + '" → "' + norm + '"');
      return JSON.stringify({ ok: true, row: rowNum, channel: norm });
    }

    Logger.log('setPatientBillingChannel: patient not found — "' + patientName + '"');
    return JSON.stringify({ ok: false, error: 'Patient not found: ' + patientName });
  } catch (e) {
    Logger.log('setPatientBillingChannel error: ' + e.message);
    return JSON.stringify({ ok: false, error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   MIGRATION — migrateAddPatientClaimCols
   Run any time PATIENT_COLS grows — adds any missing header
   columns to the Patients tab (indices 6+).
   Safe to re-run — skips columns that already exist.
════════════════════════════════════════════════════════════════ */
function migrateAddPatientClaimCols() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_PATIENT);
  if (!sheet) { Logger.log('No Patients tab found.'); return; }

  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  // Derive from PATIENT_COLS — any column beyond the original 6 may need adding
  var newCols   = PATIENT_COLS.slice(6);
  var added     = 0;

  newCols.forEach(function(col) {
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


/* ════════════════════════════════════════════════════════════════════
   ONE-TIME MIGRATION — renameHeadersForTerminologyCleanup
   ════════════════════════════════════════════════════════════════════
   Solrei OS terminology cleanup — renames the actual header CELL TEXT
   in row 1 of both tabs on the LIVE sheet to match the new
   APPT_COLS / PATIENT_COLS constants above (see the note at the top
   of APPT_COLS for the full old→new mapping and scope of this pass).
   Column POSITIONS never move — only the row-1 label text changes —
   so this has zero effect on numeric-index-based row access anywhere
   else in this file or in Tebra Sync.

   ⚠️  RUN THIS ONCE, MANUALLY, FROM THE APPS SCRIPT EDITOR — BEFORE
   deploying this version of Code.gs as a new web app version.
   If the new code deploys FIRST (with the new column-name constants)
   while the live sheet STILL has the old header text, any save that
   hits the defensive header-repair logic (savePatientClaimRecord,
   migrateAddPatientClaimCols) will conclude the new name is "missing"
   and APPEND a brand-new duplicate column instead of matching the
   existing one — splitting live data across two columns. Run this
   migration first, confirm the log looks right, THEN deploy.

   Does not read from or write to the live header row by column
   letter/number — it searches the actual header row for each OLD
   name and renames whatever column it's actually in. Robust to any
   historical drift between PATIENT_COLS/APPT_COLS and the physical
   sheet, and safe to re-run (already-renamed columns are skipped).

   HOW TO RUN:
     1. Open the Apps Script editor (bound to the Solrei ClinicBoard
        Data spreadsheet)
     2. Select  renameHeadersForTerminologyCleanup  from the function
        dropdown
     3. Click ▶ Run
     4. Check the Execution Log (View → Logs) — every column should
        show ✅ RENAMED. Investigate anything showing ⚠️ before
        deploying the new Code.gs / crb_index.html.
════════════════════════════════════════════════════════════════════ */
function renameHeadersForTerminologyCleanup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = [];

  // Appointments tab (col F, AA, AB, AC, AM). Col BB (InsuranceCarrier)
  // is already correctly named — not part of this map, no change needed.
  var APPT_RENAMES = {
    'Method':          'BillingChannel',
    'PaymentType':     'CostShareClass',
    'PaymentRate':     'CostShareRate',
    'PaymentAmount':   'CostShareCollectedAmt',
    'PaymentPlatform': 'PaymentProcessingChannel',
  };
  // Patients tab (col C, D, E, G, Q).
  var PATIENT_RENAMES = {
    'Platform':        'BillingChannel',
    'Insurance':       'InsuranceCarrier',
    'PatientPortion':  'CostShareClass',
    'ClaimPlatform':   'ClaimGateway',
    'PaymentPlatform': 'PaymentProcessingChannel',
  };

  function applyRenames(sheet, renameMap) {
    if (!sheet) { results.push('❌ Sheet not found — skipped.'); return; }
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) { results.push('❌ ' + sheet.getName() + ': no columns found.'); return; }
    var hdrRange = sheet.getRange(1, 1, 1, lastCol);
    var hdrs     = hdrRange.getValues()[0];
    var changed  = false;
    var present  = {};
    hdrs.forEach(function(h) { present[String(h || '').trim()] = true; });

    Object.keys(renameMap).forEach(function(oldName) {
      var newName = renameMap[oldName];
      if (present[newName]) {
        results.push('SKIP (already renamed): ' + sheet.getName() + ' — "' + newName + '" already present');
        return;
      }
      var idx = hdrs.indexOf(oldName);
      if (idx === -1) {
        results.push('⚠️ NOT FOUND: ' + sheet.getName() + ' — no column currently named "' + oldName +
                      '" (expected to rename to "' + newName + '") — check manually');
        return;
      }
      hdrs[idx] = newName;
      changed = true;
      results.push('✅ RENAMED: ' + sheet.getName() + ' col ' + (idx + 1) + '  "' + oldName + '" → "' + newName + '"');
    });

    if (changed) hdrRange.setValues([hdrs]);
  }

  applyRenames(ss.getSheetByName(TAB_APPT), APPT_RENAMES);
  applyRenames(ss.getSheetByName(TAB_PATIENT), PATIENT_RENAMES);

  SpreadsheetApp.flush();
  var summary = results.join('\n');
  Logger.log(summary);
  return summary;
}


/* ════════════════════════════════════════════════════════════════════
   ONE-TIME UTILITY — bulkVerifyQ1_2026
   ════════════════════════════════════════════════════════════════════
   Marks every appointment from 2026-01-01 through 2026-03-31 as
   fully verified in the Assistant Window:
     ✅  Method valid      (AlmaValid / HWValid / GrowValid / DirectValid)
     ✅  Intake Paperwork Complete   (Intake)
     ✅  Insurance Verified & Valid  (InsVerified)
     ✅  Autopay / Credit Card on File (Autopay)

   HOW TO RUN:
     1. Open Apps Script editor
     2. Select  bulkVerifyQ1_2026  from the function dropdown
     3. Click ▶ Run  (dryRun = false — live write)

   HOW TO PREVIEW FIRST (recommended):
     Select  bulkVerifyQ1_2026_dryRun  and click ▶ Run.
     Check the Execution Log — no data is changed.

   SAFE TO RE-RUN: already-TRUE values are skipped (no double-write).
   ════════════════════════════════════════════════════════════════════ */
function bulkVerifyQ1_2026_dryRun() { bulkVerifyQ1_2026(true);  }
function bulkVerifyQ1_2026()        { _bulkVerifyRange('2026-01-01', '2026-03-31', false); }

function _bulkVerifyRange(startISO, endISO, dryRun) {
  dryRun = (dryRun === true);

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_APPT);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('No appointment data found.');
    return;
  }

  // ── Column indices (0-based) ──────────────────────────────────────
  var COL_DATE      = APPT_COLS.indexOf('Date');          // 1
  var COL_METHOD    = APPT_COLS.indexOf('BillingChannel'); // 5
  var COL_ALMA_V    = APPT_COLS.indexOf('AlmaValid');     // 7
  var COL_HW_V      = APPT_COLS.indexOf('HWValid');       // 9
  var COL_GROW_V    = APPT_COLS.indexOf('GrowValid');     // 11
  var COL_INTAKE    = APPT_COLS.indexOf('Intake');        // 13
  var COL_INS       = APPT_COLS.indexOf('InsVerified');   // 14
  var COL_AUTOPAY   = APPT_COLS.indexOf('Autopay');       // 15
  var COL_STATUS    = APPT_COLS.indexOf('Status');        // 24
  var COL_LMOD      = APPT_COLS.indexOf('LastModified');  // 32
  var COL_MODBY     = APPT_COLS.indexOf('ModifiedBy');    // 33
  var COL_DIRECT_V  = APPT_COLS.indexOf('DirectValid');   // 48

  var rows    = sheet.getDataRange().getValues();
  var now     = new Date().toISOString();
  var updated = 0;
  var skipped = 0;
  var outOfRange = 0;

  Logger.log((dryRun ? '🔍 DRY RUN — ' : '✏️  LIVE — ') +
             'bulkVerifyRange ' + startISO + ' → ' + endISO);

  for (var i = 1; i < rows.length; i++) {
    var r       = rows[i];
    var rowDate = _fmtDate(r[COL_DATE]);

    // Skip rows outside the target window
    if (!rowDate || rowDate < startISO || rowDate > endISO) { outOfRange++; continue; }

    // Skip void rows (No-show / Cancelled / Rescheduled in Tebra)
    var tebraStatus = APPT_COLS.indexOf('TebraStatus') >= 0
                      ? String(r[APPT_COLS.indexOf('TebraStatus')] || '')
                      : '';
    if (_isVoidStatus(tebraStatus)) {
      Logger.log('  ↷ Skip void: row ' + (i + 1) + '  ' + String(r[4] || '') + '  ' + rowDate);
      skipped++;
      continue;
    }

    var rowNum = i + 1; // 1-based sheet row
    var method = String(r[COL_METHOD] || '').toLowerCase().trim();
    var patient = String(r[4] || '');  // Patient col

    // Determine the method-valid column (1-based) for this appointment
    var validCol1 = 0;
    if      (method === 'alma')  validCol1 = COL_ALMA_V   + 1;
    else if (method === 'hw')    validCol1 = COL_HW_V     + 1;
    else if (method === 'grow')  validCol1 = COL_GROW_V   + 1;
    else if (method === 'direct') validCol1 = COL_DIRECT_V + 1;

    Logger.log('  ' + (dryRun ? '[would update]' : '[updating]') +
               '  row ' + rowNum + '  ' + patient + '  ' + rowDate +
               '  method=' + (method || '(none)') + '  validCol=' + validCol1);

    if (!dryRun) {
      // ── Method valid ─────────────────────────────────────────────
      if (validCol1 > 0) {
        sheet.getRange(rowNum, validCol1).setValue(true);
      }
      // ── Intake, InsVerified, Autopay ─────────────────────────────
      sheet.getRange(rowNum, COL_INTAKE  + 1).setValue(true);
      sheet.getRange(rowNum, COL_INS     + 1).setValue(true);
      sheet.getRange(rowNum, COL_AUTOPAY + 1).setValue(true);
      // ── Status ───────────────────────────────────────────────────
      sheet.getRange(rowNum, COL_STATUS  + 1).setValue('valid');
      // ── Audit stamp ──────────────────────────────────────────────
      sheet.getRange(rowNum, COL_LMOD  + 1).setValue(now);
      sheet.getRange(rowNum, COL_MODBY + 1).setValue('bulkVerifyQ1_2026');
    }

    updated++;
  }

  SpreadsheetApp.flush();

  Logger.log('');
  Logger.log('══════════════════════════════════════════════');
  Logger.log((dryRun ? '🔍 DRY RUN COMPLETE' : '✅  DONE') +
             ' — ' + startISO + ' → ' + endISO);
  Logger.log('  Appointments ' + (dryRun ? 'that would be updated' : 'updated') +
             ': ' + updated);
  Logger.log('  Void/skipped: ' + skipped);
  Logger.log('  Outside range (not touched): ' + outOfRange);
  Logger.log('══════════════════════════════════════════════');
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
  var doc  = XmlService.parse(text);
  var root = doc.getRootElement();

  // Check for API-level errors
  var errEls = [];
  _findXmlElements(root, 'ErrorResponse', errEls);
  if (errEls.length && _getXmlChildText(errEls[0], 'IsError').toLowerCase() === 'true') {
    var errMsg = _getXmlChildText(errEls[0], 'ErrorMessage') ||
                 _getXmlChildText(errEls[0], 'Message') || 'Unknown API error';
    throw new Error('Tebra GetAllPatients API error: ' + errMsg);
  }

  // Look for patient elements — Tebra may wrap them as PatientData or Patient
  var patientEls = [];
  _findXmlElements(root, 'PatientData', patientEls);
  if (patientEls.length === 0) {
    _findXmlElements(root, 'Patient', patientEls);
    if (patientEls.length > 0) {
      Logger.log('ℹ️  Found patient records under <Patient> (not <PatientData>).');
    }
  }
  Logger.log('Tebra GetAllPatients returned ' + patientEls.length + ' patients.');

  if (patientEls.length === 0) {
    Logger.log('⚠️  Zero patients returned. Run testTebraGetPatientsRaw() to inspect ' +
               'the raw XML and confirm the correct container element name.');
    return {};
  }

  var patientMap = {};
  patientEls.forEach(function(el) {
    // Name — prefer PatientFullName, fall back to FirstName + LastName
    var fullNameRaw = (_findFirstXml(el, 'PatientFullName') || '').trim();
    var first       = (_findFirstXml(el, 'FirstName') || '').trim();
    var last        = (_findFirstXml(el, 'LastName')  || '').trim();

    if (!fullNameRaw && !first && !last) return;

    var nameKey = fullNameRaw
      ? _normName(fullNameRaw)
      : _normName(first + ' ' + last);
    if (!nameKey) return;

    var state    = (_findFirstXml(el, 'State') || '').trim().toUpperCase();
    var ins      = (_findFirstXml(el, 'PrimaryInsurancePolicyCompanyName') || '').trim();
    var provName = (_findFirstXml(el, 'DefaultRenderingProviderFullName')  || '').trim();

    // Keep first occurrence; update only if a later record has more data
    if (!patientMap[nameKey]) {
      patientMap[nameKey] = { state: state, insurance: ins, providerName: provName };
    } else {
      if (state    && !patientMap[nameKey].state)        patientMap[nameKey].state       = state;
      if (ins      && !patientMap[nameKey].insurance)    patientMap[nameKey].insurance   = ins;
      if (provName && !patientMap[nameKey].providerName) patientMap[nameKey].providerName = provName;
    }
  });

  Logger.log('Patient map built: ' + Object.keys(patientMap).length +
             ' unique patients from Tebra.');

  // Log a sample for verification
  var sample = Object.keys(patientMap).slice(0, 5);
  sample.forEach(function(k) {
    var d = patientMap[k];
    Logger.log('  "' + k + '" → state=' + (d.state||'—') +
               ', ins=' + (d.insurance||'—') +
               ', prov=' + (d.providerName||'—'));
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
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patSheet  = ss.getSheetByName(TAB_PATIENT);
    if (!apptSheet || apptSheet.getLastRow() < 2) {
      return JSON.stringify({ updated: 0 });
    }

    // ── Column indices ────────────────────────────────────────────────────────
    var IDX_PATIENT    = APPT_COLS.indexOf('Patient');          // 0-based (4)
    var IDX_DIRECT_INS = APPT_COLS.indexOf('DirectIns');        // 0-based (12)
    var IDX_INS_CARR   = APPT_COLS.indexOf('InsuranceCarrier'); // 0-based (53)
    var COL_INS_CARR   = IDX_INS_CARR + 1;                     // 1-based

    // ── Build name → insurance map from Patients tab ─────────────────────────
    var patInsMap = {};
    var COL_PT_FNAME = PATIENT_COLS.indexOf('FirstName');  // 0
    var COL_PT_LNAME = PATIENT_COLS.indexOf('LastName');   // 1
    var COL_PT_INS   = PATIENT_COLS.indexOf('InsuranceCarrier');  // 3

    if (patSheet && patSheet.getLastRow() > 1) {
      patSheet.getRange(2, 1, patSheet.getLastRow() - 1, PATIENT_COLS.length)
              .getValues()
              .forEach(function(r) {
                var first = String(r[COL_PT_FNAME] || '').trim();
                var last  = String(r[COL_PT_LNAME] || '').trim();
                var ins   = String(r[COL_PT_INS]   || '').trim();
                if ((first || last) && ins) {
                  patInsMap[_normName(first + ' ' + last)] = ins;
                }
              });
    }
    Logger.log('backfillInsuranceCarrier: Patients tab insurance map has ' +
               Object.keys(patInsMap).length + ' entries.');

    // ── Scan Appointments tab ─────────────────────────────────────────────────
    var lastRow  = apptSheet.getLastRow();
    var numRows  = lastRow - 1;
    var apptData = apptSheet.getRange(2, 1, numRows, APPT_COLS.length).getValues();
    var updated  = 0;

    apptData.forEach(function(row, i) {
      var existing  = String(row[IDX_INS_CARR]   || '').trim();
      if (existing && !forceOverwrite) return;  // already populated — skip unless force

      // Source 1: DirectIns on this row (from Tebra appointment sync)
      var directIns = String(row[IDX_DIRECT_INS] || '').trim();
      var carrier   = directIns;

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

    var patSheet  = ss.getSheetByName(TAB_PATIENT);
    var apptSheet = ss.getSheetByName(TAB_APPT);
    var patientsUpdated      = 0;
    var appointmentsUpdated  = 0;

    // ── Column indices (0-based for reading, 1-based for writing) ──────────────
    var COL_PT_FNAME     = PATIENT_COLS.indexOf('FirstName');     // 0-based
    var COL_PT_LNAME     = PATIENT_COLS.indexOf('LastName');      // 0-based
    var COL_PT_INS_IDX   = PATIENT_COLS.indexOf('InsuranceCarrier'); // 0-based (index 3)
    var COL_PT_STATE_IDX = PATIENT_COLS.indexOf('PatientState');  // 0-based (index 12)
    var COL_PT_INS       = COL_PT_INS_IDX   + 1;                 // 1-based for setRange
    var COL_PT_STATE     = COL_PT_STATE_IDX + 1;                 // 1-based for setRange

    // ── 1. Update Patients tab ────────────────────────────────────────────────
    if (patSheet && patSheet.getLastRow() > 1 && COL_PT_STATE > 0) {
      var ptData = patSheet.getRange(2, 1, patSheet.getLastRow() - 1, PATIENT_COLS.length).getValues();
      ptData.forEach(function(row, i) {
        var first = String(row[COL_PT_FNAME] || '').trim();
        var last  = String(row[COL_PT_LNAME] || '').trim();
        if (!first && !last) return;

        var nameKey   = _normName(first + ' ' + last);
        var tebraData = tebraPatientMap[nameKey];
        if (!tebraData) return;

        var rowNum        = i + 2;
        var existingState = String(row[COL_PT_STATE_IDX] || '').trim();
        var existingIns   = String(row[COL_PT_INS_IDX]   || '').trim();
        var anyUpdate     = false;

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
                     ' → state=' + (tebraData.state||'—') +
                     ', ins=' + (tebraData.insurance||'—'));
        }
      });
    }

    // ── 2. Back-fill Appointments tab ─────────────────────────────────────────
    var COL_APPT_PAT_IDX  = APPT_COLS.indexOf('Patient');           // 0-based (4)
    var COL_APPT_INS_IDX  = APPT_COLS.indexOf('InsuranceCarrier');  // 0-based (53)
    var COL_APPT_ST_IDX   = APPT_COLS.indexOf('PatientState');      // 0-based (54)
    var COL_APPT_INS      = COL_APPT_INS_IDX + 1;                  // 1-based
    var COL_APPT_STATE    = COL_APPT_ST_IDX  + 1;                  // 1-based

    if (apptSheet && apptSheet.getLastRow() > 1 && COL_APPT_STATE > 0) {
      var apptData = apptSheet.getRange(2, 1, apptSheet.getLastRow() - 1, APPT_COLS.length).getValues();
      apptData.forEach(function(row, i) {
        var patNameNorm = _normName(String(row[COL_APPT_PAT_IDX] || ''));
        if (!patNameNorm) return;

        var tebraData = tebraPatientMap[patNameNorm];
        if (!tebraData) return;

        var rowNum       = i + 2;
        var existingSt   = String(row[COL_APPT_ST_IDX]  || '').trim();
        var existingIns  = String(row[COL_APPT_INS_IDX] || '').trim();
        var anyUpdate    = false;

        if (tebraData.state && (forceOverwrite || !existingSt)) {
          apptSheet.getRange(rowNum, COL_APPT_STATE).setValue(tebraData.state);
          anyUpdate = true;
        }
        if (tebraData.insurance && (forceOverwrite || !existingIns)) {
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
      patientsUpdated:     patientsUpdated,
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
    var entries    = Object.keys(patientMap);
    Logger.log('Total patients returned: ' + entries.length);
    Logger.log('');
    Logger.log('First 10 entries (name → state | insurance | provider):');
    entries.slice(0, 10).forEach(function(name) {
      var d = patientMap[name];
      Logger.log('  "' + name + '" →  ' +
                 'state=' + (d.state       || '(blank)') + '  |  ' +
                 'ins='   + (d.insurance   || '(blank)') + '  |  ' +
                 'prov='  + (d.providerName|| '(blank)'));
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


/* ════════════════════════════════════════════════════════════════
   TEBRA PATIENT AUTH DIAGNOSTICS
   Run these three in order to find which request format works.
   The GetAllPatients / GetPatients endpoint requires different
   Tebra user permissions than GetAppointments.
════════════════════════════════════════════════════════════════ */

/**
 * TRY 1 — GetAllPatients with ClientVersion 2.1 in the header.
 * Some Tebra accounts require ClientVersion to pass auth on patient endpoints.
 */
function testPatientAuth_Try1_ClientVersion() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  Logger.log('=== TRY 1: GetAllPatients + ClientVersion 2.1 ===');
  var bodyXml =
    '<ns:GetAllPatients><ns:request>' +
      '<ns:RequestHeader>' +
        '<ns:ClientVersion>2.1</ns:ClientVersion>' +
        '<ns:CustomerKey>' + _xmlEscape(c.customerKey) + '</ns:CustomerKey>' +
        '<ns:Password>'    + _xmlEscape(c.password)    + '</ns:Password>'    +
        '<ns:User>'        + _xmlEscape(c.user)        + '</ns:User>'        +
      '</ns:RequestHeader>' +
      '<ns:Fields>' +
        '<ns:FirstName>true</ns:FirstName>' +
        '<ns:LastName>true</ns:LastName>' +
        '<ns:State>true</ns:State>' +
      '</ns:Fields>' +
      '<ns:Filter><ns:BatchSize>10</ns:BatchSize></ns:Filter>' +
    '</ns:request></ns:GetAllPatients>';

  try {
    var text = _tebraPost('GetAllPatients', bodyXml);
    Logger.log('Response length: ' + text.length);
    Logger.log(text.substr(0, 1200));
  } catch(e) { Logger.log('❌  ' + e.message); }
  Logger.log('=== End TRY 1 ===');
}

/**
 * TRY 2 — GetPatients (not GetAll) with correct PascalCase field names.
 * GetPatients is a lighter-permission call; your account may allow it
 * even if GetAllPatients is blocked.
 */
function testPatientAuth_Try2_GetPatients() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  Logger.log('=== TRY 2: GetPatients (not GetAllPatients) ===');
  var bodyXml =
    '<ns:GetPatients><ns:request>' +
      '<ns:RequestHeader>' +
        '<ns:ClientVersion>2.1</ns:ClientVersion>' +
        '<ns:CustomerKey>' + _xmlEscape(c.customerKey) + '</ns:CustomerKey>' +
        '<ns:Password>'    + _xmlEscape(c.password)    + '</ns:Password>'    +
        '<ns:User>'        + _xmlEscape(c.user)        + '</ns:User>'        +
      '</ns:RequestHeader>' +
      '<ns:Fields>' +
        '<ns:FirstName>true</ns:FirstName>' +
        '<ns:LastName>true</ns:LastName>' +
        '<ns:PatientFullName>true</ns:PatientFullName>' +
        '<ns:State>true</ns:State>' +
        '<ns:PrimaryInsurancePolicyCompanyName>true</ns:PrimaryInsurancePolicyCompanyName>' +
        '<ns:DefaultRenderingProviderFullName>true</ns:DefaultRenderingProviderFullName>' +
      '</ns:Fields>' +
      '<ns:Filter><ns:BatchSize>10</ns:BatchSize></ns:Filter>' +
    '</ns:request></ns:GetPatients>';

  try {
    var text = _tebraPost('GetPatients', bodyXml);
    Logger.log('Response length: ' + text.length);
    Logger.log(text.substr(0, 1500));
  } catch(e) { Logger.log('❌  ' + e.message); }
  Logger.log('=== End TRY 2 ===');
}

/**
 * TRY 3 — GetPatients with PracticeID=1 in the filter.
 * Some Tebra accounts require an explicit PracticeID for patient lookups.
 */
function testPatientAuth_Try3_WithPracticeID() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  Logger.log('=== TRY 3: GetPatients + PracticeID=1 in filter ===');
  var bodyXml =
    '<ns:GetPatients><ns:request>' +
      '<ns:RequestHeader>' +
        '<ns:ClientVersion>2.1</ns:ClientVersion>' +
        '<ns:CustomerKey>' + _xmlEscape(c.customerKey) + '</ns:CustomerKey>' +
        '<ns:Password>'    + _xmlEscape(c.password)    + '</ns:Password>'    +
        '<ns:User>'        + _xmlEscape(c.user)        + '</ns:User>'        +
      '</ns:RequestHeader>' +
      '<ns:Fields>' +
        '<ns:FirstName>true</ns:FirstName>' +
        '<ns:LastName>true</ns:LastName>' +
        '<ns:PatientFullName>true</ns:PatientFullName>' +
        '<ns:State>true</ns:State>' +
        '<ns:PrimaryInsurancePolicyCompanyName>true</ns:PrimaryInsurancePolicyCompanyName>' +
        '<ns:DefaultRenderingProviderFullName>true</ns:DefaultRenderingProviderFullName>' +
      '</ns:Fields>' +
      '<ns:Filter>' +
        '<ns:BatchSize>10</ns:BatchSize>' +
        '<ns:PracticeID>1</ns:PracticeID>' +
      '</ns:Filter>' +
    '</ns:request></ns:GetPatients>';

  try {
    var text = _tebraPost('GetPatients', bodyXml);
    Logger.log('Response length: ' + text.length);
    Logger.log(text.substr(0, 1500));
  } catch(e) { Logger.log('❌  ' + e.message); }
  Logger.log('=== End TRY 3 ===');
}


/* ── testServiceLocationNames: verify ServiceLocationName comes through GetAppointments ──
   Run this from Apps Script editor to confirm the telehealth PatientState workaround.
   Pulls today ±3 days and logs all distinct ServiceLocationName values seen.
   Expected: state names like "California", "Texas", "Florida", etc.
──────────────────────────────────────────────────────────────────────────────────────────*/
/* ── testServiceLocationFields ────────────────────────────────────────────────
   Tests two approaches for getting service location from GetAppointments:
     Test A: request <ServiceLocation> as a nested-object Field key
     Test B: omit the Fields section entirely (returns all default fields)
   Run this once; the logs will show which approach (if any) provides location data.
────────────────────────────────────────────────────────────────────────────── */
function testServiceLocationFields() {
  var c = _getTebraCreds();
  if (!c.customerKey) { Logger.log('❌  Run setTebraCreds() first.'); return; }

  var tz      = Session.getScriptTimeZone();
  var testDate = '2026-04-27';  // a date with known appointments
  var tDate    = _tebraDateFmt(_parseYMD(testDate));

  // ── Test A: request ServiceLocation (nested object) in Fields ──────────────
  Logger.log('=== Test A: ServiceLocation as nested Field key ===');
  try {
    var bodyA =
      '<ns:GetAppointments><ns:request>' +
        _tebraHeader(c) +
        '<ns:Fields>' +
          '<ns:ID>true</ns:ID>' +
          '<ns:PatientFullName>true</ns:PatientFullName>' +
          '<ns:StartDate>true</ns:StartDate>' +
          '<ns:ServiceLocation>true</ns:ServiceLocation>' +
        '</ns:Fields>' +
        '<ns:Filter>' +
          '<ns:StartDate>' + tDate + '</ns:StartDate>' +
          '<ns:EndDate>'   + tDate + '</ns:EndDate>' +
        '</ns:Filter>' +
      '</ns:request></ns:GetAppointments>';
    var textA = _tebraPost('GetAppointments', bodyA);
    var docA  = XmlService.parse(textA);
    var rootA = docA.getRootElement();
    var elsA  = [];
    _findXmlElements(rootA, 'AppointmentData', elsA);
    Logger.log('Test A returned ' + elsA.length + ' appointments');
    if (elsA.length > 0) {
      var kidsA = elsA[0].getChildren();
      Logger.log('Test A fields: ' + kidsA.map(function(k) {
        var subs = k.getChildren();
        return subs.length > 0
          ? k.getName() + '{' + subs.map(function(s){ return s.getName()+'='+s.getText(); }).join(',') + '}'
          : k.getName() + '=' + k.getText();
      }).join(', '));
    }
  } catch(eA) { Logger.log('Test A error: ' + eA.message); }

  // ── Test B: no Fields section (get all default fields) ─────────────────────
  Logger.log('=== Test B: no Fields section ===');
  try {
    var bodyB =
      '<ns:GetAppointments><ns:request>' +
        _tebraHeader(c) +
        '<ns:Filter>' +
          '<ns:StartDate>' + tDate + '</ns:StartDate>' +
          '<ns:EndDate>'   + tDate + '</ns:EndDate>' +
        '</ns:Filter>' +
      '</ns:request></ns:GetAppointments>';
    var textB = _tebraPost('GetAppointments', bodyB);
    var docB  = XmlService.parse(textB);
    var rootB = docB.getRootElement();
    var elsB  = [];
    _findXmlElements(rootB, 'AppointmentData', elsB);
    Logger.log('Test B returned ' + elsB.length + ' appointments');
    if (elsB.length > 0) {
      var kidsB = elsB[0].getChildren();
      Logger.log('Test B fields (' + kidsB.length + '): ' + kidsB.map(function(k){
        var subs = k.getChildren();
        return subs.length > 0
          ? k.getName() + '{' + subs.map(function(s){ return s.getName(); }).join(',') + '}'
          : k.getName() + '=' + k.getText();
      }).join(', '));
    }
    // Also log raw first 1200 chars to confirm what Tebra returns
    Logger.log('Test B raw (first 1200): ' + textB.substr(0, 1200));
  } catch(eB) { Logger.log('Test B error: ' + eB.message); }

  // ── Test C: ServiceLocationName alone (the name the API docs use) ──────────
  Logger.log('=== Test C: ServiceLocationName alone ===');
  try {
    var bodyC =
      '<ns:GetAppointments><ns:request>' +
        _tebraHeader(c) +
        '<ns:Fields>' +
          '<ns:ID>true</ns:ID>' +
          '<ns:StartDate>true</ns:StartDate>' +
          '<ns:ServiceLocationName>true</ns:ServiceLocationName>' +
        '</ns:Fields>' +
        '<ns:Filter>' +
          '<ns:StartDate>' + tDate + '</ns:StartDate>' +
          '<ns:EndDate>'   + tDate + '</ns:EndDate>' +
        '</ns:Filter>' +
      '</ns:request></ns:GetAppointments>';
    var textC = _tebraPost('GetAppointments', bodyC);
    var docC  = XmlService.parse(textC);
    var rootC = docC.getRootElement();
    var elsC  = [];
    _findXmlElements(rootC, 'AppointmentData', elsC);
    Logger.log('Test C returned ' + elsC.length + ' appointments');
    if (elsC.length > 0) {
      var kidsC = elsC[0].getChildren();
      Logger.log('Test C fields: ' + kidsC.map(function(k){ return k.getName()+'='+k.getText(); }).join(', '));
    }
  } catch(eC) { Logger.log('Test C error: ' + eC.message); }

  // ── Test D: ServiceLocationID alone ────────────────────────────────────────
  Logger.log('=== Test D: ServiceLocationID alone ===');
  try {
    var bodyD =
      '<ns:GetAppointments><ns:request>' +
        _tebraHeader(c) +
        '<ns:Fields>' +
          '<ns:ID>true</ns:ID>' +
          '<ns:StartDate>true</ns:StartDate>' +
          '<ns:ServiceLocationID>true</ns:ServiceLocationID>' +
        '</ns:Fields>' +
        '<ns:Filter>' +
          '<ns:StartDate>' + tDate + '</ns:StartDate>' +
          '<ns:EndDate>'   + tDate + '</ns:EndDate>' +
        '</ns:Filter>' +
      '</ns:request></ns:GetAppointments>';
    var textD = _tebraPost('GetAppointments', bodyD);
    var docD  = XmlService.parse(textD);
    var rootD = docD.getRootElement();
    var elsD  = [];
    _findXmlElements(rootD, 'AppointmentData', elsD);
    Logger.log('Test D returned ' + elsD.length + ' appointments');
    if (elsD.length > 0) {
      var kidsD = elsD[0].getChildren();
      Logger.log('Test D fields: ' + kidsD.map(function(k){ return k.getName()+'='+k.getText(); }).join(', '));
    }
  } catch(eD) { Logger.log('Test D error: ' + eD.message); }

  Logger.log('=== Done. ===');
}

// Legacy alias — kept so any saved triggers still resolve
function testServiceLocationNames() { testServiceLocationFields(); }


/* ════════════════════════════════════════════════════════════════
   RATE ANALYSIS
   Reads all paid claims from the Appointments tab, expands CPT code
   arrays, groups by InsuranceCarrier + PatientState + CPTCode, and
   writes an aggregated "Rate Analysis" tab showing what each
   insurance plan actually pays per CPT code per state.

   HOW TO USE:
     1. From Apps Script editor: run  generateRateAnalysis()
     2. From the CRB Billing View: click "📊 Rate Analysis" → "Refresh Rate Data"
     3. The "Rate Analysis" tab in your Google Sheet is updated immediately.

   The CRB Rate Lookup panel reads data back via  getRateAnalysisData()
   and displays it as a filterable table by carrier, state, and CPT code.
════════════════════════════════════════════════════════════════ */

/**
 * Generates (or regenerates) the Rate Analysis tab.
 * Reads all rows where ClaimPaidAmount > 0, expands CPT arrays,
 * groups them, and writes a sortable table.
 *
 * Output columns:
 *   Insurance Carrier | State | CPT Code | # Claims | Avg Paid | Min Paid | Max Paid | Last Paid Date
 */
function generateRateAnalysis() {
  try {
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    if (!apptSheet || apptSheet.getLastRow() < 2) {
      return JSON.stringify({ error: 'No appointment data found.' });
    }

    var COL_INS_CARRIER = APPT_COLS.indexOf('InsuranceCarrier');  // 53
    var COL_STATE       = APPT_COLS.indexOf('PatientState');       // 54
    var COL_CPT         = APPT_COLS.indexOf('CPTCodes');           // 22
    var COL_PAID_AMT    = APPT_COLS.indexOf('ClaimPaidAmount');    // 44
    var COL_PAID_DATE   = APPT_COLS.indexOf('ClaimPaidDate');      // 43
    var COL_METHOD      = APPT_COLS.indexOf('BillingChannel');     // 5

    var rows = apptSheet.getDataRange().getValues().slice(1);
    var totalScanned = 0;
    var totalPaid    = 0;

    // ── Aggregate: key = "carrier|||state|||cpt" → bucket ────────────────
    var agg = {};

    rows.forEach(function(r) {
      totalScanned++;

      // Only count Clinic Submit (direct) claims — these are the ones we submit and track
      // Platform appointments (Alma, Headway, Grow) have their own payment systems
      var method = String(r[COL_METHOD] || '').trim();
      if (method !== 'direct') return;

      // Parse paid amount — strip currency symbols and commas
      var paidAmt = parseFloat(String(r[COL_PAID_AMT] || '').replace(/[$,\s]/g, ''));
      if (isNaN(paidAmt) || paidAmt <= 0) return;

      var carrier  = String(r[COL_INS_CARRIER] || '').trim();
      var rawState = String(r[COL_STATE] || '').trim().toUpperCase();
      // Only use the state if it's a valid 2-letter US code — prevents subscriber
      // names or other contaminating data from appearing as state values.
      var state    = _isValidUSState(rawState) ? rawState : '';
      var cptRaw   = String(r[COL_CPT] || '').trim();
      var paidDate = _fmtDate(r[COL_PAID_DATE]);

      // Carrier is required for rate analysis — if blank, try directIns (col M)
      if (!carrier) {
        var DIR_INS_IDX = APPT_COLS.indexOf('DirectIns');
        if (DIR_INS_IDX >= 0) carrier = String(r[DIR_INS_IDX] || '').trim();
      }
      if (!carrier || !cptRaw) return;

      // Expand CPT code array (stored as |-separated pipe string in the sheet)
      var cptList = cptRaw.split(/[|,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      if (!cptList.length) return;

      totalPaid++;

      cptList.forEach(function(cpt) {
        var key = carrier + '|||' + state + '|||' + cpt;
        if (!agg[key]) {
          agg[key] = {
            carrier:  carrier,
            state:    state,
            cpt:      cpt,
            count:    0,
            sum:      0,
            min:      Infinity,
            max:      -Infinity,
            lastDate: '',
          };
        }
        agg[key].count++;
        agg[key].sum += paidAmt;
        if (paidAmt < agg[key].min) agg[key].min = paidAmt;
        if (paidAmt > agg[key].max) agg[key].max = paidAmt;
        if (paidDate && paidDate > agg[key].lastDate) agg[key].lastDate = paidDate;
      });
    });

    // ── Sort: Carrier → State → CPT ──────────────────────────────────────
    var data = Object.keys(agg).map(function(k) { return agg[k]; });
    data.sort(function(a, b) {
      if (a.carrier < b.carrier) return -1;
      if (a.carrier > b.carrier) return  1;
      if (a.state   < b.state)   return -1;
      if (a.state   > b.state)   return  1;
      if (a.cpt     < b.cpt)     return -1;
      if (a.cpt     > b.cpt)     return  1;
      return 0;
    });

    // ── Write to Rate Analysis tab ────────────────────────────────────────
    var rateSheet = ss.getSheetByName(TAB_RATE_ANALYSIS);
    if (!rateSheet) {
      rateSheet = ss.insertSheet(TAB_RATE_ANALYSIS);
    } else {
      rateSheet.clearContents();
    }
    rateSheet.setTabColor('#059669');

    var headers = [
      'Insurance Carrier',
      'State',
      'CPT Code',
      '# Claims',
      'Avg Paid',
      'Min Paid',
      'Max Paid',
      'Last Paid Date',
      'Generated',
    ];

    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    var sheetData = [headers].concat(data.map(function(row) {
      var avg = row.count > 0 ? (row.sum / row.count) : 0;
      return [
        row.carrier,
        row.state || '',
        row.cpt,
        row.count,
        Math.round(avg * 100) / 100,
        row.min === Infinity   ? 0 : Math.round(row.min * 100) / 100,
        row.max === -Infinity  ? 0 : Math.round(row.max * 100) / 100,
        row.lastDate || '',
        now,  // stamp generation time so users know when data was last refreshed
      ];
    }));

    // Write all rows in one batch call
    var writeRange = rateSheet.getRange(1, 1, sheetData.length, headers.length);
    writeRange.setValues(sheetData);

    // Header styling
    styleHeaderRow(rateSheet, headers.length, '#059669', '#F2EDDB');
    rateSheet.setFrozenRows(1);

    // Currency formatting for Avg/Min/Max columns (E, F, G = cols 5, 6, 7)
    if (data.length > 0) {
      rateSheet.getRange(2, 5, data.length, 3).setNumberFormat('$#,##0.00');
    }

    // Column widths
    var colWidths = [200, 55, 80, 75, 90, 90, 90, 115, 130];
    colWidths.forEach(function(w, i) { rateSheet.setColumnWidth(i + 1, w); });

    SpreadsheetApp.flush();

    _audit(ss, 'RATE_ANALYSIS_GENERATED',
      data.length + ' rate rows written. Scanned ' + totalScanned +
      ' appt rows, ' + totalPaid + ' paid direct-pay claims processed.');

    Logger.log('✅  generateRateAnalysis: ' + data.length + ' rows written to "' +
               TAB_RATE_ANALYSIS + '" tab. (' + totalPaid + ' paid claims across ' +
               totalScanned + ' scanned rows)');

    return JSON.stringify({ ok: true, rows: data.length, paidClaims: totalPaid });

  } catch (e) {
    Logger.log('generateRateAnalysis error: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ error: e.message });
  }
}

/**
 * Returns the Rate Analysis data as JSON for the CRB Rate Lookup panel.
 * Reads the already-generated Rate Analysis tab — call generateRateAnalysis()
 * first (or click "Refresh Rate Data" in the CRB) to populate it.
 */
function getRateAnalysisData() {
  try {
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var rateSheet = ss.getSheetByName(TAB_RATE_ANALYSIS);
    if (!rateSheet || rateSheet.getLastRow() < 2) {
      return JSON.stringify([]);
    }
    var rows = rateSheet.getDataRange().getValues().slice(1);
    return JSON.stringify(rows.map(function(r) {
      return {
        carrier:   String(r[0] || ''),
        state:     String(r[1] || ''),
        cpt:       String(r[2] || ''),
        count:     Number(r[3] || 0),
        avg:       Number(r[4] || 0),
        min:       Number(r[5] || 0),
        max:       Number(r[6] || 0),
        lastDate:  String(r[7] || ''),
        generated: String(r[8] || ''),
      };
    }).filter(function(r) { return r.carrier && r.cpt; }));
  } catch (e) {
    Logger.log('getRateAnalysisData error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


/* ════════════════════════════════════════════════════════════════
   PROVIDER RATE ANALYSIS
   Same logic as generateRateAnalysis() but adds Provider as the
   outermost grouping dimension. Writes to a separate sheet tab so
   the simple (non-provider) analysis is never overwritten.
   Only surfaced in the Billing View of the CRB — Provider View
   shows the simpler carrier-only breakdown.
════════════════════════════════════════════════════════════════ */
function generateProviderRateAnalysis() {
  try {
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var apptSheet = ss.getSheetByName(TAB_APPT);
    if (!apptSheet || apptSheet.getLastRow() < 2) {
      return JSON.stringify({ error: 'No appointment data found.' });
    }

    // ── Build ProvID → DisplayName map from STAFF tab ─────────────────────
    var provNames  = {};
    var staffSheet = ss.getSheetByName(TAB_STAFF);
    if (staffSheet && staffSheet.getLastRow() > 1) {
      staffSheet.getDataRange().getValues().slice(1).forEach(function(sr) {
        var provId = String(sr[STAFF_COLS.indexOf('ProvID')]      || '').trim();
        var disp   = String(sr[STAFF_COLS.indexOf('DisplayName')] || '').trim();
        if (provId && provId !== '*' && disp) provNames[provId] = disp;
      });
    }

    var COL_PROV_ID     = APPT_COLS.indexOf('ProvID');            // 0
    var COL_INS_CARRIER = APPT_COLS.indexOf('InsuranceCarrier');  // 53
    var COL_STATE       = APPT_COLS.indexOf('PatientState');       // 54
    var COL_CPT         = APPT_COLS.indexOf('CPTCodes');           // 22
    var COL_PAID_AMT    = APPT_COLS.indexOf('ClaimPaidAmount');    // 44
    var COL_PAID_DATE   = APPT_COLS.indexOf('ClaimPaidDate');      // 43
    var COL_METHOD      = APPT_COLS.indexOf('BillingChannel');     // 5

    var rows         = apptSheet.getDataRange().getValues().slice(1);
    var totalScanned = 0;
    var totalPaid    = 0;
    var agg          = {};

    rows.forEach(function(r) {
      totalScanned++;

      var method = String(r[COL_METHOD] || '').trim();
      if (method !== 'direct') return;

      var paidAmt = parseFloat(String(r[COL_PAID_AMT] || '').replace(/[$,\s]/g, ''));
      if (isNaN(paidAmt) || paidAmt <= 0) return;

      var provId   = String(r[COL_PROV_ID]   || '').trim();
      var carrier  = String(r[COL_INS_CARRIER]|| '').trim();
      var state    = String(r[COL_STATE]      || '').trim().toUpperCase();
      var cptRaw   = String(r[COL_CPT]        || '').trim();
      var paidDate = _fmtDate(r[COL_PAID_DATE]);

      // Fallback: try DirectIns when InsuranceCarrier is blank
      if (!carrier) {
        var DIR_IDX = APPT_COLS.indexOf('DirectIns');
        if (DIR_IDX >= 0) carrier = String(r[DIR_IDX] || '').trim();
      }
      if (!provId || !carrier || !cptRaw) return;

      var cptList = cptRaw.split(/[|,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      if (!cptList.length) return;

      totalPaid++;
      var provDisplay = provNames[provId] || provId;

      cptList.forEach(function(cpt) {
        var key = provId + '|||' + carrier + '|||' + state + '|||' + cpt;
        if (!agg[key]) {
          agg[key] = {
            provider: provDisplay,
            carrier:  carrier,
            state:    state,
            cpt:      cpt,
            count:    0,
            sum:      0,
            min:      Infinity,
            max:      -Infinity,
            lastDate: '',
          };
        }
        agg[key].count++;
        agg[key].sum += paidAmt;
        if (paidAmt < agg[key].min) agg[key].min = paidAmt;
        if (paidAmt > agg[key].max) agg[key].max = paidAmt;
        if (paidDate && paidDate > agg[key].lastDate) agg[key].lastDate = paidDate;
      });
    });

    // ── Sort: Provider → Carrier → State → CPT ───────────────────────────
    var data = Object.keys(agg).map(function(k) { return agg[k]; });
    data.sort(function(a, b) {
      if (a.provider < b.provider) return -1; if (a.provider > b.provider) return 1;
      if (a.carrier  < b.carrier)  return -1; if (a.carrier  > b.carrier)  return 1;
      if (a.state    < b.state)    return -1; if (a.state    > b.state)    return 1;
      if (a.cpt      < b.cpt)      return -1; if (a.cpt      > b.cpt)      return 1;
      return 0;
    });

    // ── Write to "Rate Analysis - By Provider" tab ───────────────────────
    var rateSheet = ss.getSheetByName(TAB_RATE_ANALYSIS_PROV);
    if (!rateSheet) {
      rateSheet = ss.insertSheet(TAB_RATE_ANALYSIS_PROV);
    } else {
      rateSheet.clearContents();
    }
    rateSheet.setTabColor('#1C6FA3');   // blue tab to distinguish from plain Rate Analysis

    var headers = ['Provider','Insurance Carrier','State','CPT Code',
                   '# Claims','Avg Paid','Min Paid','Max Paid','Last Paid Date','Generated'];

    var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    var sheetData = [headers].concat(data.map(function(row) {
      var avg = row.count > 0 ? (row.sum / row.count) : 0;
      return [
        row.provider,
        row.carrier,
        row.state    || '',
        row.cpt,
        row.count,
        Math.round(avg * 100) / 100,
        row.min === Infinity  ? 0 : Math.round(row.min * 100) / 100,
        row.max === -Infinity ? 0 : Math.round(row.max * 100) / 100,
        row.lastDate || '',
        now,
      ];
    }));

    var writeRange = rateSheet.getRange(1, 1, sheetData.length, headers.length);
    writeRange.setValues(sheetData);

    styleHeaderRow(rateSheet, headers.length, '#1C6FA3', '#F2EDDB');
    rateSheet.setFrozenRows(1);

    if (data.length > 0) {
      rateSheet.getRange(2, 6, data.length, 3).setNumberFormat('$#,##0.00');
    }

    var colWidths = [110, 200, 50, 80, 70, 90, 90, 90, 115, 130];
    colWidths.forEach(function(w, i) { rateSheet.setColumnWidth(i + 1, w); });

    SpreadsheetApp.flush();

    _audit(ss, 'PROVIDER_RATE_ANALYSIS_GENERATED',
      data.length + ' rows written (' + totalPaid + ' paid claims, ' + totalScanned + ' scanned).');

    Logger.log('✅  generateProviderRateAnalysis: ' + data.length + ' rows → "' +
               TAB_RATE_ANALYSIS_PROV + '" (' + totalPaid + ' paid claims)');

    return JSON.stringify({ ok: true, rows: data.length, paidClaims: totalPaid });

  } catch (e) {
    Logger.log('generateProviderRateAnalysis error: ' + e.message + '\n' + e.stack);
    return JSON.stringify({ error: e.message });
  }
}


/**
 * Returns the Provider Rate Analysis data as JSON for the CRB Billing View panel.
 * Call generateProviderRateAnalysis() first to populate the sheet.
 */
function getProviderRateAnalysisData() {
  try {
    var ss        = SpreadsheetApp.getActiveSpreadsheet();
    var rateSheet = ss.getSheetByName(TAB_RATE_ANALYSIS_PROV);
    if (!rateSheet || rateSheet.getLastRow() < 2) return JSON.stringify([]);
    var rows = rateSheet.getDataRange().getValues().slice(1);
    return JSON.stringify(rows.map(function(r) {
      return {
        provider:  String(r[0] || ''),
        carrier:   String(r[1] || ''),
        state:     String(r[2] || ''),
        cpt:       String(r[3] || ''),
        count:     Number(r[4] || 0),
        avg:       Number(r[5] || 0),
        min:       Number(r[6] || 0),
        max:       Number(r[7] || 0),
        lastDate:  String(r[8] || ''),
        generated: String(r[9] || ''),
      };
    }).filter(function(r) { return r.provider && r.carrier && r.cpt; }));
  } catch (e) {
    Logger.log('getProviderRateAnalysisData error: ' + e.message);
    return JSON.stringify({ error: e.message });
  }
}


// ════════════════════════════════════════════════════════════════════════════
// BULK PAYMENT IMPORT
// Called by the CRB Biller Window → "📥 Import Payments" panel.
// ════════════════════════════════════════════════════════════════════════════

function bulkImportPayments(rowsJson) {
  try {
    var ss    = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(TAB_APPT);
    if (!sheet) return JSON.stringify({ error: 'Appointments sheet not found' });

    var importRows = JSON.parse(rowsJson);
    if (!Array.isArray(importRows) || importRows.length === 0)
      return JSON.stringify({ matched: [], unmatched: [], total: 0 });

    var IDX_PROV_ID  = APPT_COLS.indexOf('ProvID');
    var IDX_DATE     = APPT_COLS.indexOf('Date');
    var IDX_APPT_ID  = APPT_COLS.indexOf('ApptID');
    var IDX_PATIENT  = APPT_COLS.indexOf('Patient');
    var IDX_STATUS   = APPT_COLS.indexOf('ClaimStatus');
    var IDX_PAID_AMT = APPT_COLS.indexOf('ClaimPaidAmount');
    var COL_STATUS   = IDX_STATUS   + 1;
    var COL_PAID_AMT = IDX_PAID_AMT + 1;

    // Headway may use legal names that differ from CRB provID (e.g. Katherine → katie)
    var provMap = {
      jodene:     'jodene',
      katherine:  'katie',   // Headway full name
      katie:      'katie',
      megan:      'megan',
      lori:       'lori',
    };
    var staffSheet = ss.getSheetByName(TAB_STAFF);
    if (staffSheet && staffSheet.getLastRow() > 1) {
      staffSheet.getDataRange().getValues().slice(1).forEach(function(r) {
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
      var longer  = ta.length <= tb.length ? tb : ta;
      return shorter.every(function(tok) { return longer.indexOf(tok) >= 0; });
    }

    function normProvId(name) {
      var first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
      return provMap[first] || first;
    }

    var allValues = sheet.getDataRange().getValues();
    var matched = [], unmatched = [];

    importRows.forEach(function(row) {
      var targetDate = normDate(row.date          || row['APPOINTMENT DATE'] || '');
      var targetProv = normProvId(row.providerName || row['PROVIDER NAME']    || '');
      var targetPat  = normPat(row.patientName    || row['PATIENT NAME']      || '');
      var payAmt     = String(row.paymentAmount   || row['PAYMENT AMOUNT']    || '').trim();

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
      allValues[foundIdx][IDX_STATUS]   = 'Paid';

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