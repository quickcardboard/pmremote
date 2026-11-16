// node test/parse.test.js — parser + rules on fictional LATITUDE pages
const fs = require("fs"), path = require("path"), assert = require("assert");
const P = require("../src/core.js");
const load = (f) => P.parseLatitude(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"));
let n = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };

const a = load("alpha.txt");
eq(a.patient.name, "TESTPATIENT, ALPHA", "name");
eq(a.device.serial, "900001", "serial");
eq(a.device.model, "L331 ACCOLADE MRI EL", "model");
eq(a.site, "PAH", "site from tags");
eq(a.device.mode, "DDIR", "mode");
eq(a.device_alerts, ["Atrial intrinsic amplitude out of range."], "alerts");
eq(a.reason, "amplitude_oor", "reason");
const ra = a.leads.find((l) => l.chamber === "RA"), rv = a.leads.find((l) => l.chamber === "RV");
eq([ra.amplitude_mv, ra.impedance_ohm, ra.previous_impedance_ohm, ra.threshold_v, ra.office.thr.v], [0.9, 700, 674, undefined, 0.6], "RA: daily threshold N/R, in-office kept for display");
eq([rv.amplitude_mv, rv.amplitude_op, rv.impedance_ohm, rv.previous_impedance_ohm, rv.threshold_v], [25, ">", 492, 479, 0.7], "RV");
eq(a.battery.years, 7.5, "battery");
eq(a.pacing_percent, { atrial: 3, ventricular: 100 }, "paced");
eq(a.atrial_burden_percent, null, "burden N/R");
eq(a.episodes, [], "no episodes");
eq(a.since_reset, "29 Sep 2026", "reset");
const fa = P.evaluate(a, P.DEFAULTS).map((f) => f.title);
eq(fa, [], "alpha: P wave 0.9 mV ignored in DDIR; alert is the reason, not a flag");
eq(P.evaluate(Object.assign({}, a, { device: { mode: "DDDR" } }), P.DEFAULTS).map((f) => f.title), ["P wave 0.9 mV"], "P wave < 1.0 flagged in DDDR");
eq(P.evaluate(Object.assign({}, a, { device: { mode: "DDDR" }, atrial_burden_percent: 80, atrial_burden_op: "" }), P.DEFAULTS).map((f) => f.title),
  ["AT/AF burden 80%"], "P wave ignored when burden > 50%");

const b = load("bravo.txt");
eq(b.device.serial, "900003", "serial on next line");
eq(b.site, "JPOCSC", "site");
eq(b.device.mode, "VVIR", "mode");
const rb = b.leads.find((l) => l.chamber === "RV"), ab = b.leads.find((l) => l.chamber === "RA");
eq([rb.amplitude_mv, rb.impedance_ohm, rb.previous_impedance_ohm, rb.threshold_v], [3.7, 569, 362, 0.9], "RV bravo");
eq([ab.amplitude_mv, ab.impedance_ohm, ab.threshold_v], [undefined, 482, undefined], "RA bravo N/R");
eq(b.atrial_burden_percent, 4.5, "burden");
eq(b.episodes.map((e) => [e.type, e.count]), [["NSVT", 1], ["SVT", 2], ["AHR", 3]], "episodes");
eq(b.device_notes, [], "MV sensor message dropped");
eq(b.reason, "scheduled", "reason default");
const fb = P.evaluate(b, P.DEFAULTS).map((f) => f.level + ": " + f.title);
eq(fb, ["warn: RV impedance rose 362 → 569 Ω (57%)", "warn: RV R wave 3.7 mV"], "bravo flags: burden 4.5% under 20%, episodes not flagged");
eq(b.ahr_longest, null, "3 AHR events: longest unknown from the Summary");

const c = load("charlie.txt");
eq(c.site, "RMH", "site");
eq(c.atrial_total_seconds, 125.4 * 60, "AT/AF overview total, not the Health daily value");
eq(c.ahr_longest, "2 hours", "single AHR event: longest = total, rounded");
eq([c.battery.years, c.battery.text], [0.8, "10 months"], "months kept as months for the report");
const fc = P.evaluate(c, P.DEFAULTS).map((f) => f.level + ": " + f.title);
eq(fc, ["critical: RV impedance 1100 Ω", "warn: Battery 10 months to explant", "warn: RA impedance fell 400 → 300 Ω (25%)",
  "warn: RA threshold 1.8 V @ 0.4 ms (last check 1 V)"], "charlie flags: RV 2.0 V within 0.25 V of 1.9 V is not flagged");

// Durations round to the nearest hour, minute or second
eq([P.fmtDur(42), P.fmtDur(59.4), P.fmtDur(90), P.fmtDur(3569), P.fmtDur(5400), P.fmtDur(7600), P.fmtDur(9230), P.fmtDur(3700)],
  ["42 seconds", "59 seconds", "1.5 minutes", "59.5 minutes", "1.5 hours", "2 hours", "2.5 hours", "1 hour"], "fmtDur");
eq([P.durSeconds("01:02:03"), P.durSeconds("2 hr 5 min"), P.durSeconds("12", "min"), P.durSeconds("N/R")], [3723, 7500, 720, null], "durSeconds");

const junk = P.parseLatitude("hello world");
eq(junk.recognised, false, "unrecognised page");
const dl = load("delta.txt");
eq(dl.device.serial, "900011", "serial on the line after the model");
eq(dl.site, null, "Search Tags: None");
eq([dl.atrial_burden_op, dl.atrial_burden_percent], ["<", 1], "burden <1 %");
eq(dl.ahr_longest, "7 seconds", "longest from the AT/AF overview");
const fd = P.evaluate(dl, P.DEFAULTS).map((f) => f.level + ": " + f.title);
eq(fd, ["warn: No clinic in search tags"], "delta flags");
const e = load("echo.txt");
const era = e.leads.find((l) => l.chamber === "RA"), erv = e.leads.find((l) => l.chamber === "RV");
eq([era.impedance_ohm, era.previous_impedance_ohm, erv.impedance_ohm, erv.previous_impedance_ohm], [763, 750, 677, 658], "ohm sign U+2126");
eq([era.daily.thr, era.office.thr.v, era.threshold_v], [null, 1.0, undefined], "daily N/R: no alert value, in-office shown");
eq([era.daily.amp.v, era.office.amp.v], [0.8, 0.4], "daily and in-office side by side");
eq(e.office_date, "21 Sep 2026", "in-office date");
eq(e.ahr_longest, "6.5 hours", "06:41:40 rounds to the nearest half hour");
eq(e.atrial_burden_percent, 98, "burden");
eq(P.evaluate(e, P.DEFAULTS).map((f) => f.title), ["AT/AF burden 98%"], "echo flags: P wave 0.8 ignored with burden 98%");
eq([P.lastName("TESTPATIENT, ALPHA"), P.lastName("O'NEIL-SMITH, MARY ANN"), P.lastName("Mary Testpatient")], ["TESTPATIENT", "O'NEIL-SMITH", "Testpatient"], "last name");
const fx = load("foxtrot.txt");
const fra = fx.leads.find((l) => l.chamber === "RA"), frv = fx.leads.find((l) => l.chamber === "RV");
eq(fx.daily_first, true, "Daily column stored first");
eq([fra.daily.amp.v, fra.office.amp.v, fra.daily.imp.v, fra.office.imp.v, fra.daily.thr, fra.office.thr.v], [5.8, 3.1, 664, 648, null, 0.5], "RA daily/in-office");
eq([frv.daily.amp.v, frv.office.amp.v, frv.daily.thr.v, frv.office.thr.v, frv.office.thr.auto], [17.5, 14.4, 0.6, 0.8, true], "RV daily/in-office");
eq([a.daily_first, e.daily_first], [false, false], "In-Office-first pages unchanged");
const g = load("golf.txt");
eq(g.ahr_longest, "2.5 hours", "02:33:50 -> 2.5 hours");
eq(P.evaluate(g, P.DEFAULTS).map((f) => f.title), [], "RV R wave daily N/R: no alert (in-office 3.0 mV ignored)");
const ht = load("hotel.txt");
eq(ht.ahr_longest, ">48 hours", "Longest '>48 Hours' kept; Fastest 20:08:45 not used");
eq(ht.device_alerts, ["Atrial Arrhythmia Burden of at least 24.0 hours in a 24 hour period between 14 Nov 2026 01:21 and 15 Nov 2026 01:21."], "wrapped alert joined");
eq(ht.reason, "atrial_burden", "reason");
const ind = load("india.txt");
eq(ind.leads.map((l) => [l.chamber, l.daily.amp.op + l.daily.amp.v, l.daily.imp.v, l.office.imp.v, l.daily.thr.v]), [["RV", ">25", 902, 925, 0.7]], "VVIR: unlabelled lead is RV");
eq(ind.pacing_percent, { ventricular: 91 }, "unlabelled percent paced is ventricular in VVIR");
eq(ind.episodes.map((e) => [e.type, e.count]), [["NSVT", 1]], "Nonsustained Episodes counted");
eq(ind.site, "DH", "site");
eq([P.fmtDur(80), P.fmtDur(75), P.fmtDur(60)], ["1.5 minutes", "1.5 minutes", "1 minute"], "half minutes");
// ---- Medtronic CareLink
const k = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kilo.txt"), "utf8"));
eq([k.source, k.icd, k.patient.name, k.device.serial, k.device.mode, k.site], ["CareLink", false, "TESTPATIENT, KILO D", "TST900071G", "AAI<=>DDD", "JPOCSC"], "CareLink PM header");
eq(k.leads.map((l) => [l.chamber, l.impedance_ohm, l.threshold_v, l.amplitude_mv]), [["RA", 513, 0.5, 3.1], ["RV", 456, 0.375, 13.8]], "CareLink PM leads");
eq(k.episodes.map((e) => [e.type, e.count]), [["VT", 2], ["AHR", 7]], "VT (>4 beats) -> VHR, AT/AF -> AHR");
eq([k.atrial_burden_percent, k.battery.text, k.pacing_percent], [0.5, "13.7 years", { ventricular: 0.3, atrial: 22.7 }], "burden from brackets, battery, pacing");
eq(P.evaluate(k, P.DEFAULTS).map((f) => f.title), [], "CareLink PM: no alerts");
const lm = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "lima.txt"), "utf8"));
eq([lm.icd, lm.battery.text, lm.atrial_burden_op, lm.atrial_burden_percent, lm.therapies_delivered, lm.treated, lm.oversensing], [true, "20 months", "<", 0.1, 0, 0, 0], "CareLink ICD");
eq(lm.leads.map((l) => [l.coil || l.chamber, l.impedance_ohm]), [["RA", 380], ["RV", 342], ["RV", 70]], "pacing + HV impedance");
eq(lm.episodes.map((e) => [e.type, e.count]), [["VT", 2]], "VT-NS -> VHR");
eq(P.evaluate(lm, P.DEFAULTS).map((f) => f.title), [], "CareLink ICD: no alerts");
const lm2 = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "lima.txt"), "utf8").replace("Total Shocks\n0\n0", "Total Shocks\n2\n0").replace("RV=70 ohms", "RV=160 ohms").replace("V. Oversensing-TWave Rx Withheld\n0", "V. Oversensing-TWave Rx Withheld\n3"));
eq(P.evaluate(lm2, P.DEFAULTS).map((f) => f.level + ": " + f.title), ["critical: HV (RV) impedance 160 Ω", "critical: Therapy delivered (2)", "warn: 3 oversensing episodes (Rx withheld)"], "ICD therapy, HV and oversensing alerts");
const mk = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mike.txt"), "utf8"));
eq([mk.episodes_page, mk.ahr_longest, mk.ahr_longest_listed], [true, "24.5 hours", 7], "Episodes tab: longest AT/AF 24:17:18");
const both = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kilo.txt"), "utf8") + "\n" + fs.readFileSync(path.join(__dirname, "fixtures", "mike.txt"), "utf8"));
eq([both.episodes_page, both.ahr_longest, both.leads.length], [false, "24.5 hours", 2], "Current Status + Episodes pasted together");
eq([P.cellSeconds(":01"), P.cellSeconds(":01:21"), P.cellSeconds("24:17:18"), P.cellSeconds("10-Oct-2026")], [1, 81, 87438, null], "Episodes duration cells");
eq(P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "alpha.txt"), "utf8")).source, "LATITUDE", "LATITUDE still detected");

const nv = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "november.txt"), "utf8"));
eq(nv.episodes.map((e) => [e.type, e.count]), [["VT", 43], ["SVT", 89], ["AHR", 3532]], "'3,532' read; Fast A&V counted on the SVT line");
const os = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "oscar.txt"), "utf8"));
eq([os.ahr_longest, os.ahr_longest_listed, os.svt_longest, os.svt_longest_listed], ["54 seconds", 6, "1.5 minutes at 162 BPM", 8], "longest AT/AF; longest of SVT, SVT-AF and Fast A&V with V rate");
eq(P.cellSeconds("<:01"), 0.5, "'<:01' is under a second");

const pa = P.parse(fs.readFileSync(path.join(__dirname, "fixtures", "papa.txt"), "utf8"));
eq([pa.source, pa.events_page, pa.vhr_longest, pa.vhr_longest_listed, pa.device.serial, pa.interrogated], ["LATITUDE", true, "2 seconds at 172 BPM", 2, "900101", "19 Oct 2026 01:41"],
  "LATITUDE Events: longest V-# minus 10 s, with onset rate");
eq(P.parseLatitudeEvents(P.lines("V-132 15 Oct 2026 21:03 NonSustV Avg V Rate at Onset: 172 min-1 00:00:12\nATR-7357 17 Oct 2026 06:50 ATR Avg V Rate in ATR: 104 min-1 00:41:46")),
  { vhr: { seconds: 2, vrate: 172, listed: 1 } }, "Events row flattened onto one line");
eq(os.vhr_longest, "2 seconds at 167 BPM", "CareLink Episodes: longest VT-NS with V rate");
eq([P.pageIdent(fs.readFileSync(path.join(__dirname, "fixtures", "kilo.txt"), "utf8")), P.pageIdent(fs.readFileSync(path.join(__dirname, "fixtures", "papa.txt"), "utf8")), P.pageIdent("Patient list")],
  ["CL|TST900071G|16-Nov-2026 09:55:08", "LAT|900101|19 Oct 2026 01:41", ""], "page identity for auto-close");

// Alerts come from the daily value; N/R daily = no alert; low sensing within 20% of in-office = no alert
const lead = (daily, office) => ({ chamber: "RV", daily: { amp: daily }, office: { amp: office } });
const sense = (dl, of) => {
  const L = lead(dl == null ? null : { v: dl, op: "" }, of == null ? null : { v: of, op: "" });
  if (L.daily.amp) { L.amplitude_mv = dl; L.amplitude_op = ""; if (of != null) L.previous_amplitude_mv = of; }
  return P.evaluate({ device: {}, battery: { years: 5 }, leads: [L], site: "DH", tags: [], episodes: [], device_alerts: [], device_notes: [], pacing_percent: {} }, P.DEFAULTS).map((f) => f.title);
};
eq(sense(null, 3.0), [], "daily N/R: no alert even with a low in-office value");
eq(sense(4.5, 5.0), [], "4.5 vs 5.0 mV (10%): no alert");
eq(sense(3.5, 5.0), ["RV R wave 3.5 mV"], "3.5 vs 5.0 mV (30%): alert");
eq(sense(3.0, null), ["RV R wave 3 mV"], "no in-office value: alert");
console.log("ok", n, "checks");
