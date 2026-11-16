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
eq(c.battery.years, 0.8, "months to years");
const fc = P.evaluate(c, P.DEFAULTS).map((f) => f.level + ": " + f.title);
eq(fc, ["critical: RV impedance 1100 Ω", "warn: Battery 0.8 years to explant", "warn: RA impedance fell 400 → 300 Ω (25%)",
  "warn: RA threshold 1.8 V @ 0.4 ms (last check 1 V)"], "charlie flags: RV 2.0 V within 0.25 V of 1.9 V is not flagged");

// Durations round to the nearest hour, minute or second
eq([P.fmtDur(42), P.fmtDur(59.4), P.fmtDur(90), P.fmtDur(3569), P.fmtDur(5400), P.fmtDur(7600), P.fmtDur(9230), P.fmtDur(3700)],
  ["42 seconds", "59 seconds", "2 minutes", "59 minutes", "1.5 hours", "2 hours", "2.5 hours", "1 hour"], "fmtDur");
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
