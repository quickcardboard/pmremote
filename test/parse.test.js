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
eq([ra.amplitude_mv, ra.impedance_ohm, ra.previous_impedance_ohm, ra.threshold_v], [0.9, 700, 674, 0.6], "RA");
eq([rv.amplitude_mv, rv.amplitude_op, rv.impedance_ohm, rv.previous_impedance_ohm, rv.threshold_v], [25, ">", 492, 479, 0.7], "RV");
eq(a.battery.years, 7.5, "battery");
eq(a.pacing_percent, { atrial: 3, ventricular: 100 }, "paced");
eq(a.atrial_burden_percent, null, "burden N/R");
eq(a.episodes, [], "no episodes");
eq(a.since_reset, "29 Sep 2026", "reset");
const fa = P.evaluate(a, P.DEFAULTS).map((f) => f.title);
eq(fa, ["P wave 0.9 mV", "Ventricular pacing 100%", "Alert: Atrial intrinsic amplitude out of range.", "Advisory patient (search tag)"], "alpha flags");

const b = load("bravo.txt");
eq(b.device.serial, "900003", "serial on next line");
eq(b.site, "JPOCSC", "site");
eq(b.device.mode, "VVIR", "mode");
const rb = b.leads.find((l) => l.chamber === "RV"), ab = b.leads.find((l) => l.chamber === "RA");
eq([rb.amplitude_mv, rb.impedance_ohm, rb.previous_impedance_ohm, rb.threshold_v], [3.7, 569, 362, 0.9], "RV bravo");
eq([ab.amplitude_mv, ab.impedance_ohm, ab.threshold_v], [undefined, 482, undefined], "RA bravo N/R");
eq(b.atrial_burden_percent, 4.5, "burden");
eq(b.episodes.map((e) => [e.type, e.count]), [["NSVT", 1], ["SVT", 2], ["AHR", 3]], "episodes");
eq(b.device_notes, ["The MV Sensor has been disabled by the Signal Artifact Monitor (SAM) device diagnostic."], "notes");
eq(b.reason, "scheduled", "reason default");
const fb = P.evaluate(b, P.DEFAULTS).map((f) => f.level + ": " + f.title);
eq(fb, ["warn: RV impedance 362 → 569 Ω (57%)", "warn: RV R wave 3.7 mV", "warn: AT/AF burden 4.5%", "warn: 1 × Nonsustained V episodes",
  "warn: 2 × SVT episodes (V<=A)", "warn: 3 × AT/AF events", "warn: The MV Sensor has been disabled by the Signal Artifact Monitor (SAM) device diagnostic.",
  "info: Advisory patient (search tag)"], "bravo flags");

const junk = P.parseLatitude("hello world");
eq(junk.recognised, false, "unrecognised page");
console.log("ok", n, "checks");
