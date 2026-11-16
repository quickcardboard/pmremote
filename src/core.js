/* PM Remote core: LATITUDE text parser, threshold rules, report templates and the review panel.
   No network, no AI: everything runs in the browser (or in Node for tests). */
(function (root) {
"use strict";

var SITES = ["LMH", "JPOCSC", "SMH", "ERH", "DH", "PAH", "RMH", "ARH"];
var DEFAULTS = { impLow: 200, impHigh: 1000, impChangePct: 20, pMin: 1.0, pIgnoreBurden: 50, rMin: 5, thrMax: 1.5, thrDelta: 0.25, senseChangePct: 20, burdenWarn: 20, batteryWarn: 1 };
var THR_LABELS = [
  ["impLow", "Pacing lead impedance low (Ω)"], ["impHigh", "Pacing lead impedance high (Ω)"],
  ["impChangePct", "Impedance change since last check (%)"], ["pMin", "P wave below (mV)"], ["rMin", "R wave below (mV)"],
  ["thrMax", "Capture threshold above (V)"], ["thrDelta", "…unless within (V) of last check"],
  ["senseChangePct", "Low sensing ignored when within (%) of in-office"],
  ["pIgnoreBurden", "Ignore low P wave when AT/AF burden above (%)"], ["burdenWarn", "AT/AF burden above (%)"], ["batteryWarn", "Battery at or below (years)"]
];

/* ---------------- Parser ---------------- */
var DATE = "\\d{1,2} [A-Z][a-z]{2} \\d{4}";

function lines(text) {
  return String(text || "").replace(/\r/g, "").replace(/ /g, " ")
    .split(/[\n\t]+/).map(function (s) { return s.replace(/\s+/g, " ").trim(); }).filter(Boolean);
}
function num(s) { var m = String(s).match(/\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }

function parseLatitude(text) {
  var L = lines(text), J = L.join("\n");
  var grab = function (re) { var m = J.match(re); return m ? m[1].trim() : null; };
  var d = { source: "LATITUDE", device: {}, patient: {}, leads: [], episodes: [], device_alerts: [], device_notes: [], pacing_percent: {}, battery: {}, tags: [] };

  d.patient.name = grab(/Patient(?: Name)?:\s*([^\n]+)/i);
  d.patient.dob = grab(/Date of Birth:\s*([^\n]+)/i);
  // "Device: L331 ACCOLADE MRI EL/990147"; the "MODEL/serial" tail may wrap onto a later line
  var di = L.findIndex(function (s) { return /^Device:/i.test(s); });
  if (di >= 0) {
    var dev = L[di].replace(/^Device:\s*/i, "");
    for (var w = di + 1; w <= di + 3 && w < L.length && !/\/\s*\d+\s*$/.test(dev); w++) {
      if (/^[A-Z0-9 -]*\/\s*\d+$/.test(L[w])) dev += " " + L[w];
    }
    var sm = dev.match(/^(.*?)\s*\/\s*(\d+)\s*$/);
    d.device.model = (sm ? sm[1] : dev).trim();
    d.device.serial = sm ? sm[2] : null;
  }
  if (!d.device.serial) {
    var dm = J.match(/Device:\s*([^\n]*?)\s*\/\s*(\d{4,})/i);
    if (dm) { d.device.model = d.device.model || dm[1].trim(); d.device.serial = dm[2]; }
  }
  d.interrogated = grab(new RegExp("Latest Device Transmission:\\s*(" + DATE + "(?: \\d{1,2}:\\d{2})?)", "i"));
  var ti = L.findIndex(function (s) { return /^Search Tags:/i.test(s); });
  if (ti >= 0) {
    var tags = L[ti].replace(/^Search Tags:\s*/i, "").replace(/Monitoring Status.*$/i, "").trim();
    // a long tag list can wrap: take a following all-capitals line that holds a clinic code
    for (var tw = ti + 1; tw <= ti + 2 && tw < L.length; tw++)
      if (/^[A-Z0-9 ]+$/.test(L[tw]) && SITES.some(function (c) { return L[tw].split(" ").indexOf(c) >= 0; })) tags += " " + L[tw];
    d.tags = tags.split(/\s+/).filter(Boolean);
  }
  d.site = SITES.filter(function (s) { return d.tags.indexOf(s) >= 0; })[0] || null;
  d.advisory = d.tags.indexOf("ADVISORY") >= 0;
  d.measured = grab(new RegExp("Most Recent\\s+Daily\\s+Measurement\\s*\\(?(" + DATE + ")", "i"));
  d.office_date = grab(new RegExp("Most Recent\\s+In-?\\s*Office\\s+Measurement\\s*\\(?(" + DATE + ")", "i"));
  d.since_reset = grab(new RegExp("Since Last Reset\\s+(" + DATE + ")", "i"));
  d.device.mode = grab(/(?:^|\n)Mode\s+([A-Z]{3,5})(?=\n|$)/);

  // Alerts: between "My Alerts" and the support line / Leads header
  var a0 = L.findIndex(function (s) { return /^My Alerts$/i.test(s); });
  if (a0 >= 0) {
    var newAlert = true;
    for (var i = a0 + 1; i < L.length; i++) {
      if (/^(For Technical Support|Leads\b)/i.test(L[i])) break;
      // each alert starts after its date/time; text that wraps onto more lines belongs to the same alert
      if (new RegExp("^" + DATE + "(?: \\d{1,2}:\\d{2})?$").test(L[i])) { newAlert = true; continue; }
      if (newAlert || !d.device_alerts.length) d.device_alerts.push(L[i]);
      else d.device_alerts[d.device_alerts.length - 1] += " " + L[i];
      newAlert = false;
    }
  }

  // Leads: track the chamber header, then read each measurement row
  var CH = { "atrial": "RA", "ventricular": "RV", "right ventricular": "RV", "left ventricular": "LV", "rv": "RV", "lv": "LV" };
  var LAB = [["intrinsic amplitude", "amp"], ["pace impedance", "imp"], ["pace threshold", "thr"], ["shock impedance", "shock"], ["high voltage impedance", "shock"]];
  var isVal = function (s) { return /^(\(|N\/R|Auto\b|[<>]?\s*\d|@|ms\b)/i.test(s); };
  var chamber = null, leads = {}, order = [];
  // Column order follows the page text, not the screen: LATITUDE can store the Daily column first and
  // display it on the right. Use the order of the two headings just before the first lead row.
  var firstRow = J.search(/\n(Intrinsic Amplitude|Pace Impedance|Pace Threshold)\b/i);
  var head = firstRow > 0 ? J.slice(0, firstRow) : J;
  var lastIdx = function (re) { var m, i = -1, g = new RegExp(re.source, "gi"); while ((m = g.exec(head))) i = m.index; return i; };
  var officeAt = lastIdx(/In-?\s*Office\s+Measurement/), dailyAt = lastIdx(/Daily\s+Measurement/);
  d.daily_first = officeAt >= 0 && dailyAt >= 0 && dailyAt < officeAt;
  for (var k = 0; k < L.length; k++) {
    var line = L[k].replace(/^[^A-Za-z(]+/, "");
    var low = line.toLowerCase();
    if (CH[low]) { chamber = CH[low]; continue; }
    var lab = null;
    for (var q = 0; q < LAB.length; q++) if (low.indexOf(LAB[q][0]) === 0) { lab = LAB[q]; break; }
    if (!lab) continue;
    if (!chamber && lab[1] !== "shock") chamber = singleChamber(d.device.mode) || "RV";
    var buf = line.slice(lab[0].length), j = k + 1;
    while (j < L.length && isVal(L[j])) { buf += " " + L[j]; j++; }
    k = j - 1;
    var key = lab[1] === "shock" ? "HV" : chamber;
    if (!leads[key]) { leads[key] = { chamber: key }; order.push(key); }
    var ld = leads[key];
    var clean = buf.replace(new RegExp("\\(\\s*" + DATE + "\\s*\\)", "g"), " ");
    // Columns are [in-office, daily]; read each cell in order, N/R included, so a blank daily never
    // passes the in-office value off as current.
    var kind = lab[1] === "shock" ? "imp" : lab[1];
    var cells = readCells(clean, kind);
    ld.office = ld.office || {}; ld.daily = ld.daily || {};
    if (cells.length >= 2) { ld.office[kind] = cells[d.daily_first ? 1 : 0]; ld.daily[kind] = cells[d.daily_first ? 0 : 1]; }
    else if (cells.length === 1) ld.daily[kind] = cells[0];
  }
  Object.keys(leads).forEach(function (c) {
    // Alert values are the most recent daily ones only (N/R = no alert); in-office is the comparison.
    var l = leads[c], am = l.daily.amp, im = l.daily.imp, th = l.daily.thr;
    if (am) { l.amplitude_mv = am.v; l.amplitude_op = am.op; if (l.office.amp) l.previous_amplitude_mv = l.office.amp.v; }
    if (im) { l.impedance_ohm = im.v; if (l.office.imp) l.previous_impedance_ohm = l.office.imp.v; }
    if (th) { l.threshold_v = th.v; l.threshold_pw_ms = th.pw; if (l.office.thr) l.previous_threshold_v = l.office.thr.v; }
  });
  d.leads = order.map(function (c) { return leads[c]; });

  // Battery
  var bm = J.match(/time to explant:?\s*([<>]?\s*\d+(?:\.\d+)?)\s*(years?|months?)/i);
  if (bm) {
    var bmo = /^month/i.test(bm[2]);
    d.battery.years = Math.round(num(bm[1]) / (bmo ? 12 : 1) * 10) / 10;
    d.battery.text = num(bm[1]) + (bmo ? " months" : " years");   // as LATITUDE gives it
  }
  if (/time to explant:?\s*(Explant|ERI|EOL)/i.test(J) || /\b(Explant Indicator|End of Life|EOL reached)\b/i.test(J)) d.battery.status = "ERI";

  // Percent paced
  var pp = J.search(/Percent Paced/i);
  if (pp >= 0) {
    var sub = J.slice(pp, pp + 160);
    var pa = sub.match(/Atrial\s+[<>]?\s*(\d+(?:\.\d+)?)\s*%/), pv = sub.match(/Ventricular\s+[<>]?\s*(\d+(?:\.\d+)?)\s*%/);
    if (pa) d.pacing_percent.atrial = +pa[1];
    if (pv) d.pacing_percent.ventricular = +pv[1];
    var plv = sub.match(/(?:LV|Left Ventricular)\s+[<>]?\s*(\d+(?:\.\d+)?)\s*%/);
    if (plv) d.pacing_percent.lv = +plv[1];
    if (!pa && !pv) {
      var p1 = sub.match(/Percent Paced\s+[<>]?\s*(\d+(?:\.\d+)?)\s*%/i), sc = singleChamber(d.device.mode);
      if (p1) d.pacing_percent[sc === "RA" ? "atrial" : "ventricular"] = +p1[1];
    }
  }

  // AT/AF burden and event counts
  var burden = J.match(/AT\/AF(?:\s*\([^)]*\))?\s+([<>]?)\s*(\d+(?:\.\d+)?|N\/R)\s*%/i);
  d.atrial_burden_percent = burden && /\d/.test(burden[2]) ? +burden[2] : null;
  d.atrial_burden_op = burden && d.atrial_burden_percent != null ? burden[1] : "";
  var cnt = function (re) { var mm = J.match(re); return mm && /\d/.test(mm[1]) ? +mm[1] : null; };
  var ep = [
    ["VT", cnt(/(?<![A-Za-z])VT Episodes\s*(?:\([^)]*\))?\s+(\d+|N\/R)/i), "VT episodes (V>A)"],
    ["VF", cnt(/(?<![A-Za-z])VF Episodes\s*(?:\([^)]*\))?\s+(\d+|N\/R)/i), "VF episodes"],
    ["VT", cnt(/(?<![A-Za-z])Tachy Episodes\s+(\d+|N\/R)/i), "Tachy episodes"],
    ["NSVT", cnt(/Nonsustained\s*V?\s*Episodes\s+(\d+|N\/R)/i), "Nonsustained V episodes"],
    ["SVT", cnt(/(?<![A-Za-z])SVT Episodes\s*(?:\([^)]*\))?\s+(\d+|N\/R)/i), "SVT episodes (V<=A)"],
    ["AHR", cnt(/AT\/AF Events\s+(\d+|N\/R)/i), "AT/AF events"],
    ["AF48", cnt(/Atrial Episodes\s*>\s*48\s*hr?\s+(\d+|N\/R)/i), "Atrial episodes > 48 h"]
  ];
  ep.forEach(function (e) { if (e[1]) d.episodes.push({ type: e[0], count: e[1], label: e[2] }); });
  // Longest AHR: LATITUDE's Summary shows only the total time in AT/AF since reset, which equals the
  // longest episode when there was exactly one.
  var ov = J.search(/AT\/AF Overview/i);
  var tt = (ov >= 0 ? J.slice(ov, ov + 600) : "").match(/Total Time in AT\/AF(?:\s*\(([^)]*)\))?(?:\s*\([^)]*\))*\s+([^\n]+)/i);
  d.atrial_total_seconds = tt ? durSeconds(tt[2], tt[1]) : null;
  var ahrN = (d.episodes.filter(function (e) { return e.type === "AHR"; })[0] || {}).count;
  d.ahr_longest = ahrN === 1 && d.atrial_total_seconds ? fmtDur(d.atrial_total_seconds) : null;
  // The overview lists "Longest (date)" / "Avg V Rate, Duration (hh:mm:ss)" / "69 min-1, 00:00:07" (or ">48 Hours").
  // Read only the value under "Longest", never the next entry (Fastest).
  var li = ov >= 0 ? L.findIndex(function (s, i) { return i > 0 && /^Longest\b/i.test(s) && J.indexOf(s) >= ov; }) : -1;
  if (li >= 0) {
    for (var lk = li + 1; lk <= li + 3 && lk < L.length; lk++) {
      if (/^(Fastest|Most Recent)\b/i.test(L[lk])) break;
      var lv = L[lk].replace(/^.*Duration\s*\([^)]*\)/i, "");
      var gt = lv.match(/([<>])\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|minutes?|mins?)/i);
      var hms = lv.match(/\b(\d+:\d{2}:\d{2})\b/);
      if (gt) { var u = gt[3].toLowerCase()[0]; d.ahr_longest = gt[1] + gt[2] + (u === "h" ? " hours" : u === "d" ? " days" : " minutes"); break; }
      if (hms) { d.ahr_longest = fmtDur(durSeconds(hms[1])) || d.ahr_longest; break; }
    }
  }
  var shocks = cnt(/Shocks?(?: Delivered)?\s+(\d+)/i), atp = cnt(/ATP(?: Delivered| Therapies)?\s+(\d+)/i);
  d.therapies_delivered = (shocks || 0) + (atp || 0) || null;

  // Device messages worth reading (safety mode, disabled sensors, suspended tests)
  var seen = {};
  L.forEach(function (s) {
    if (/(disabled|suspended|safety (mode|core)|failed|failure|exceeded|reverted)/i.test(s) && !/(MV Sensor|Signal Artifact Monitor)/i.test(s) && s.length < 220 && !seen[s] && d.device_alerts.indexOf(s) < 0) { seen[s] = 1; d.device_notes.push(s); }
  });

  // Reason for transmission from the alert text
  var at = d.device_alerts.join(" ");
  d.reason = /1003/.test(at) ? "error_1003" : /threshold.*suspend/i.test(at) ? "threshold_suspended" : /intrinsic amplitude/i.test(at) ? "amplitude_oor"
    : /(V-?Tachy|VT\b|ventricular tachy)/i.test(at) ? "vt" : /(AT\/AF|atrial (burden|arrhythmia))/i.test(at) ? "atrial_burden" : "scheduled";
  d.recognised = d.leads.length > 0 || d.battery.years != null;
  // Events tab (Arrhythmia Logbook): longest V-# event, when that text is here
  var ev = parseLatitudeEvents(L);
  if (ev) { d.vhr_longest = episodeText(ev.vhr, true); d.vhr_longest_listed = ev.vhr.listed; }
  d.events_page = /Arrhythmia Logbook/i.test(J) && !d.recognised;
  return d;
}

// LATITUDE Events tab rows: "V-132", "15 Oct 2026 21:03", "NonSustV", "Avg V Rate at Onset: 172 min-1", "00:00:12".
// Longest V-# event with its onset rate; LATITUDE durations include 10 s of onset, so 10 s is taken off.
function parseLatitudeEvents(L) {
  var best = null, n = 0;
  for (var i = 0; i < L.length; i++) {
    // whole row on one line ("V-132 15 Oct 2026 21:03 NonSustV Avg V Rate at Onset: 172 min-1 00:00:12")
    var one = L[i].match(/^V-\d+\s.*?(\d{1,2}):(\d{2}):(\d{2})\s*$/);
    if (one) {
      var s1 = Math.max(0, +one[1] * 3600 + +one[2] * 60 + +one[3] - 10), r1 = L[i].match(/Avg V Rate[^:]*:\s*(\d+)/i);
      n++;
      if (!best || s1 > best.seconds) best = { seconds: s1, vrate: r1 ? +r1[1] : null };
      continue;
    }
    if (!/^V-\d+$/.test(L[i])) continue;
    var rate = null;
    for (var j = i + 1; j <= i + 5 && j < L.length; j++) {
      if (/^[A-Z][A-Za-z\u2122]*-\d+$/.test(L[j])) break;           // next event
      var r = L[j].match(/Avg V Rate[^:]*:\s*(\d+)/i);
      if (r) rate = +r[1];
      var m = L[j].match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
      if (m) {
        var sec = Math.max(0, +m[1] * 3600 + +m[2] * 60 + +m[3] - 10);
        n++;
        if (!best || sec > best.seconds) best = { seconds: sec, vrate: rate };
        break;
      }
    }
  }
  return n ? { vhr: { seconds: best.seconds, vrate: best.vrate, listed: n } } : null;
}

// Duration text -> seconds. unit: a hint from the label, e.g. "min".
function durSeconds(text, unit) {
  text = String(text || "").trim();
  if (!/\d/.test(text)) return null;
  var c = text.match(/^(\d+):(\d{2})(?::(\d{2}))?/);
  if (c) return c[3] != null ? +c[1] * 3600 + +c[2] * 60 + +c[3] : +c[1] * 60 + +c[2];
  var total = 0, any = false, re = /(\d+(?:\.\d+)?)\s*(days?|d\b|hours?|hrs?|h\b|minutes?|mins?|m\b|seconds?|secs?|s\b)/gi, m;
  while ((m = re.exec(text))) {
    any = true; var u = m[2].toLowerCase()[0];
    total += +m[1] * (u === "d" ? 86400 : u === "h" ? 3600 : u === "m" ? 60 : 1);
  }
  if (any) return total;
  var n = parseFloat(text), uh = String(unit || "").toLowerCase();
  if (/^min/.test(uh)) return n * 60;
  if (/^(h|hr|hour)/.test(uh)) return n * 3600;
  if (/^s/.test(uh)) return n;
  return null;
}
// Round to the nearest second, half minute or half hour, whichever applies.
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  var pl = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
  if (sec < 59.5) return pl(Math.max(1, Math.round(sec)), "second");
  var m = Math.round(sec / 30) / 2;
  if (m < 60) return m + " minute" + (m === 1 ? "" : "s");
  var h = Math.round(sec / 1800) / 2;
  return h + " hour" + (h === 1 ? "" : "s");
}

// One measurement row -> cells in column order. Each cell is null (N/R) or {v, op, pw, auto}.
var OHM = "[\u03A9\u2126]";
function readCells(text, kind) {
  var re = kind === "amp" ? /N\/R|([<>]?)\s*(\d+(?:\.\d+)?)\s*mV/gi
    : kind === "imp" ? new RegExp("N\\/R|([<>]?)\\s*(\\d+(?:\\.\\d+)?)(?:\\s*(?:" + OHM + "|ohms?\\b))?", "gi")
    : /N\/R|(Auto\s*)?(\d+(?:\.\d+)?)\s*V\s*@\s*(\d+(?:\.\d+)?)\s*ms/gi;
  var out = [], m;
  while ((m = re.exec(text))) {
    if (/^N\/R$/i.test(m[0])) { out.push(null); continue; }
    if (kind === "thr") out.push({ v: +m[2], pw: +m[3], auto: !!m[1] });
    else out.push({ v: +m[2], op: m[1] || "" });
  }
  return out;
}

// Single-chamber devices have no Atrial/Ventricular heading: AAI(R) is an atrial lead, VVI(R) a ventricular one.
function singleChamber(mode) {
  return /^A(AI|OO|AT)/.test(mode || "") ? "RA" : /^V(VI|OO|VT)/.test(mode || "") ? "RV" : null;
}

/* ---------------- Medtronic CareLink ---------------- */
var MDATE = "\\d{1,2}-[A-Z][a-z]{2,3}-\\d{4}";

// "<0.1%" -> {v: 0.1, op: "<"}
function pct(s) { var m = String(s || "").match(/([<>]?)\s*(\d+(?:\.\d+)?)\s*%/); return m ? { v: +m[2], op: m[1] } : null; }

// Duration cell from the Episodes list: ":01" = 1 s, ":01:21" = 81 s, "24:17:18" = 24 h 17 min 18 s, "<:01" = under 1 s
function cellSeconds(s) {
  s = String(s || "");
  var lt = s.charAt(0) === "<";
  if (lt) s = s.slice(1);
  if (!/^\d*:\d{2}(?::\d{2})?$/.test(s)) return null;
  var v = s.split(":").reduce(function (a, x) { return a * 60 + (+x || 0); }, 0);
  return lt ? v - 0.5 : v;                       // "<:01" ranks below ":01"
}

// Episodes tab rows read Type, ID#, date, time, duration, "A/V" average rates. Longest episode per group:
// AT/AF, and SVT (SVT, SVT-AF and Fast A&V together) with its ventricular rate.
var EP_GROUPS = { ahr: /^(AT\/AF|AT|AF)$/i, svt: /^(SVT|SVT-AF|Fast A\s*&\s*V)$/i, vhr: /^(VT|VT-NS|VF|FVT|VT-Mon|VT Monitor|High Rate-NS)$/i };
function parseCarelinkEpisodes(L) {
  var out = {};
  for (var i = 1; i + 3 < L.length; i++) {
    if (!/^#\d+$/.test(L[i]) || !new RegExp("^" + MDATE + "$").test(L[i + 1])) continue;
    var sec = cellSeconds(L[i + 3]);
    if (sec == null) continue;
    for (var g in EP_GROUPS) {
      if (!EP_GROUPS[g].test(L[i - 1])) continue;
      var r = String(L[i + 4] || "").match(/^(\d+|--)\s*\/\s*(\d+)/);
      var o = out[g] || (out[g] = { seconds: -1, listed: 0 });
      o.listed++;
      if (sec > o.seconds) { o.seconds = sec; o.vrate = r ? +r[2] : null; }
    }
  }
  return Object.keys(out).length ? out : null;
}
// "1.5 minutes", plus "at 162 BPM" when the ventricular rate is over 100
function episodeText(g, withRate) {
  if (!g) return null;
  var t = g.seconds < 1 ? "under 1 second" : fmtDur(g.seconds);
  return t + (withRate && g.vrate > 100 ? " at " + g.vrate + " BPM" : "");
}

function parseCarelink(text) {
  var L = lines(text), J = L.join("\n");
  var grab = function (re) { var m = J.match(re); return m ? m[1].trim() : null; };
  var d = { source: "CareLink", device: {}, patient: {}, leads: [], episodes: [], device_alerts: [], device_notes: [], pacing_percent: {}, battery: {}, tags: [] };
  d.patient.name = (L.filter(function (s) { return /^[A-Z][A-Z'\- ]*, [A-Z][A-Z'\-. ]*$/.test(s); })[0]) || null;
  var dev = grab(/Device:\s*([^\n]+)/i);
  if (dev) d.device.model = dev.replace(/™/g, "").replace(/\s+/g, " ");
  d.device.serial = grab(/Serial Number:\s*(\S+)/i);
  d.interrogated = grab(new RegExp("Date of Interrogation:\\s*(" + MDATE + ")", "i"));
  d.since_reset = grab(new RegExp("Clinical Status\\s+Since\\s+(" + MDATE + ")", "i"));
  d.measured = d.interrogated;
  d.site = "JPOCSC"; d.siteChoice = true;           // Medtronic: JPOCSC unless changed
  var mi = L.findIndex(function (s, i) { return s === "Mode" && i > L.findIndex(function (x) { return /^Parameter Summary$/i.test(x); }); });
  d.device.mode = mi >= 0 && L[mi + 1] ? L[mi + 1].replace(/\s+/g, "") : null;
  d.icd = /Defibrillation Impedance|Therapy Summary|^Treated$/im.test(J);

  // Clinical Status counters: "label" then a number on the next line, split into Treated and Monitored
  var cs = L.findIndex(function (s) { return /^Clinical Status$/i.test(s); });
  var ce = L.findIndex(function (s, i) { return i > cs && /^(Functional|Pacing|Therapy Summary|OBSERVATIONS|Device Status)\b/i.test(s); });
  var block = "", counts = { treated: {}, monitored: {} };
  for (var i = cs + 1; cs >= 0 && i < (ce > 0 ? ce : L.length) - 1; i++) {
    if (/^Treated$/i.test(L[i])) { block = "treated"; continue; }
    if (/^Monitored$/i.test(L[i])) { block = "monitored"; continue; }
    if (block && /^\d{1,3}(,\d{3})*$/.test(L[i + 1]) && !/^[\d,]+$/.test(L[i])) counts[block][L[i]] = +L[i + 1].replace(/,/g, "");
    if (/^Time in AT\/AF$/i.test(L[i])) { var b = pct(L[i + 1]); if (b) { d.atrial_burden_percent = b.v; d.atrial_burden_op = b.op; } }
  }
  var sum = function (o, re) { return Object.keys(o).filter(function (k) { return re.test(k); }).reduce(function (a, k) { return a + o[k]; }, 0); };
  var M = counts.monitored;
  var vhr = sum(M, /^(VT\b|VT-NS|High Rate-NS)/i), svt = sum(M, /^(SVT\b|Fast A\s*&\s*V)/i), ahr = sum(M, /^AT\/AF$/i);
  var over = sum(M, /Oversensing/i);
  if (vhr) d.episodes.push({ type: "VT", count: vhr, label: "VHR episodes" });
  if (svt) d.episodes.push({ type: "SVT", count: svt, label: "SVT episodes" });
  if (ahr) d.episodes.push({ type: "AHR", count: ahr, label: "AT/AF episodes" });
  d.oversensing = over;
  d.treated = sum(counts.treated, /^(VF|FVT|VT)$/i);

  // Therapy Summary: label, then the VT/VF and AT/AF columns
  var row = function (re) {
    var k = L.findIndex(function (s) { return re.test(s); });
    if (k < 0) return 0;
    var t = 0; for (var j = k + 1; j <= k + 2 && j < L.length && /^\d{1,3}(,\d{3})*$/.test(L[j]); j++) t += +L[j].replace(/,/g, "");
    return t;
  };
  if (d.icd) {
    d.therapies_delivered = row(/^Pace-Terminated Episodes$/i) + row(/^Shock-Terminated Episodes$/i) + row(/^Total Shocks$/i);
    d.aborted_charges = row(/^Aborted Charges$/i);
  }

  // Pacing %
  var pv = function (re) { var k = L.findIndex(function (s) { return re.test(s); }); return k >= 0 ? pct(L[k + 1]) : null; };
  var vp = pv(/^(Total VP|VP)$/), ap = pv(/^AP$/), apvs = pv(/^AP-VS$/), apvp = pv(/^AP-VP$/);
  if (vp) d.pacing_percent.ventricular = vp.op === "<" ? 0 : vp.v;
  if (ap) d.pacing_percent.atrial = ap.v;
  else if (apvs || apvp) d.pacing_percent.atrial = Math.round(((apvs ? apvs.v : 0) + (apvp ? apvp.v : 0)) * 10) / 10;

  // Battery
  var bl = L.findIndex(function (s) { return /^Remaining Longevity$/i.test(s); });
  var bm = bl >= 0 ? String(L[bl + 1]).match(/([<>]?\s*\d+(?:\.\d+)?)\s*(years?|months?)/i) : null;
  if (bm) {
    var mo = /^month/i.test(bm[2]);
    d.battery.years = Math.round(num(bm[1]) / (mo ? 12 : 1) * 10) / 10;
    d.battery.text = num(bm[1]) + (mo ? " months" : " years");
  }
  if (/\b(RRT|ERI|EOS)\b/.test(J.slice(J.search(/Device Status/i)))) d.battery.status = "RRT";

  // Leads: chamber headings "Atrial(4470)" "RV(4471)", then one value per chamber on each row
  var CHM = { atrial: "RA", ra: "RA", rv: "RV", lv: "LV", "right ventricular": "RV", "left ventricular": "LV" };
  var hk = L.findIndex(function (s) { return /^(Atrial|RA|RV|LV)\s*\([^)]*\)$/i.test(s); });
  var chambers = [];
  for (var h = hk; hk >= 0 && h < L.length && /^(Atrial|RA|RV|LV)\s*\([^)]*\)$/i.test(L[h]); h++) chambers.push(CHM[L[h].replace(/\s*\(.*$/, "").toLowerCase()]);
  var leads = chambers.map(function (c) { return { chamber: c, daily: {}, office: {} }; });
  var take = function (re, kind) {
    var k = L.findIndex(function (s, x) { return x > hk && re.test(s); });
    if (k < 0) return;
    var j = k + 1;
    leads.forEach(function (ld) {
      var t = L[j] || "", cell;
      if (/^(--+|N\/?A|N\/R)$/i.test(t)) { j++; ld.daily[kind] = null; return; }
      if (kind === "imp") cell = t.match(/^([<>]?)\s*(\d+(?:\.\d+)?)\s*ohms?$/i);
      else if (kind === "amp") cell = t.match(/^([<>]?)\s*(\d+(?:\.\d+)?)\s*mV$/i);
      else cell = t.match(/^(\d+(?:\.\d+)?)\s*V\s*@\s*(\d+(?:\.\d+)?)\s*ms$/i);
      if (!cell) return;               // empty cell: leave this chamber without a value
      j++;
      ld.daily[kind] = kind === "thr" ? { v: +cell[1], pw: +cell[2] } : { v: +cell[2], op: cell[1] };
    });
  };
  if (hk >= 0) {
    take(/^(Lead|Pacing) Impedance$/i, "imp");
    take(/^Capture Threshold$/i, "thr");
    take(/^Measured P\s*\/\s*R Wave$/i, "amp");
  }
  leads.forEach(function (l) {
    if (l.daily.amp) { l.amplitude_mv = l.daily.amp.v; l.amplitude_op = l.daily.amp.op; }
    if (l.daily.imp) l.impedance_ohm = l.daily.imp.v;
    if (l.daily.thr) { l.threshold_v = l.daily.thr.v; l.threshold_pw_ms = l.daily.thr.pw; }
  });
  // Defibrillation impedance "RV=70 ohms" (possibly also "SVC=..."): one HV entry per coil
  var di = L.findIndex(function (s) { return /^Defibrillation Impedance$/i.test(s); });
  if (di >= 0) {
    var re = /([A-Z]+)\s*=\s*([<>]?)\s*(\d+)\s*ohms?/gi, m, seg = L.slice(di + 1, di + 3).join(" ");
    while ((m = re.exec(seg))) leads.push({ chamber: "HV", coil: m[1].toUpperCase(), impedance_ohm: +m[3], daily: { imp: { v: +m[3], op: m[2] } }, office: {} });
  }
  d.leads = leads;

  // Longest AT/AF from the Episodes tab, when that text is here too (pasted together)
  var epi = parseCarelinkEpisodes(L);
  if (epi) {
    if (epi.ahr) { d.ahr_longest = episodeText(epi.ahr, false); d.ahr_longest_listed = epi.ahr.listed; }
    if (epi.svt) { d.svt_longest = episodeText(epi.svt, true); d.svt_longest_listed = epi.svt.listed; }
    if (epi.vhr) { d.vhr_longest = episodeText(epi.vhr, true); d.vhr_longest_listed = epi.vhr.listed; }
  }
  d.episodes_page = /Arrhythmia Episodes with EGM/i.test(J) && !/Remaining Longevity/i.test(J);
  d.recognised = d.leads.length > 0 || d.battery.years != null;
  return d;
}

function isCarelink(text) { return /Date of Interrogation/i.test(text) && /Serial Number/i.test(text); }
function parse(text) { return isCarelink(text) ? parseCarelink(text) : parseLatitude(text); }

/* ---------------- Rules ---------------- */

function evaluate(d, T) {
  var f = [];
  var add = function (level, title, rule, tag) { f.push({ level: level, title: title, rule: rule, tag: tag }); };
  var b = d.battery || {};
  if (b.status) add("critical", "Battery " + b.status, "Battery at replacement indicator", "batt");
  else if (b.years != null && b.years <= T.batteryWarn) add("warn", "Battery " + (b.text || b.years + " years") + " to explant", "≤ " + T.batteryWarn + " years", "batt");
  else if (b.years == null) add("info", "Battery longevity not found", "Check by hand", "batt");
  (d.leads || []).forEach(function (l) {
    var ch = l.chamber, hv = ch === "HV", lo = hv ? 20 : T.impLow, hi = hv ? 150 : T.impHigh;
    var z = l.impedance_ohm, zp = l.previous_impedance_ohm;
    if (z != null && (z < lo || z > hi)) add("critical", (hv && l.coil ? "HV (" + l.coil + ")" : ch) + " impedance " + z + " Ω", "Outside " + lo + "–" + hi + " Ω", "imp");
    if (z != null && zp) {
      var pct = Math.round(Math.abs(z - zp) / zp * 100);
      if (pct > T.impChangePct) add("warn", ch + " impedance " + (z > zp ? "rose" : "fell") + " " + zp + " → " + z + " Ω (" + pct + "%)", "Change > " + T.impChangePct + "% since last check", "imp");
    }
    var a = l.amplitude_mv, ap = l.previous_amplitude_mv;
    var steady = a != null && ap ? Math.abs(a - ap) / ap * 100 <= T.senseChangePct : false;
    if (a != null && l.amplitude_op !== ">" && !steady) {
      var inAF = d.device.mode === "DDIR" || (d.atrial_burden_percent != null && d.atrial_burden_op !== "<" && d.atrial_burden_percent > T.pIgnoreBurden);
      if (ch === "RA" && a < T.pMin && !inAF) add("warn", "P wave " + a + " mV", "< " + T.pMin + " mV (not DDIR, burden ≤ " + T.pIgnoreBurden + "%)" + (ap ? ", in-office " + ap + " mV" : ""), "sense");
      if ((ch === "RV" || ch === "LV") && a < T.rMin) add("warn", ch + " R wave " + a + " mV", "< " + T.rMin + " mV" + (ap ? ", in-office " + ap + " mV" : ""), "sense");
    }
    var tv = l.threshold_v, tp = l.previous_threshold_v;
    if (tv != null && !hv && tv > T.thrMax && !(tp != null && Math.abs(tv - tp) <= T.thrDelta + 1e-9))
      add("warn", ch + " threshold " + tv + " V @ " + l.threshold_pw_ms + " ms" + (tp != null ? " (last check " + tp + " V)" : ""),
        "> " + T.thrMax + " V and not within " + T.thrDelta + " V of last check", "sense");
  });
  if (d.oversensing) add("warn", d.oversensing + " oversensing episode" + (d.oversensing === 1 ? "" : "s") + " (Rx withheld)", "T-wave or noise oversensing", "over");
  if (d.treated) add("critical", d.treated + " treated VT/VF episode" + (d.treated === 1 ? "" : "s"), "Treated VF/FVT/VT counters", "therapy");
  if (d.source === "CareLink" && d.therapies_delivered) add("critical", "Therapy delivered (" + d.therapies_delivered + ")", "Pace- or shock-terminated episodes or shocks", "therapy");
  if (d.aborted_charges) add("warn", d.aborted_charges + " aborted charge" + (d.aborted_charges === 1 ? "" : "s"), "Therapy Summary", "therapy");
  if (!d.site && d.source !== "CareLink") add("warn", "No clinic in search tags", "Expected one of " + SITES.join(", ") + (d.tags.length ? "; tags: " + d.tags.join(" ") : ""), "site");
  if (d.atrial_burden_percent != null && d.atrial_burden_op !== "<" && d.atrial_burden_percent > T.burdenWarn) add("warn", "AT/AF burden " + d.atrial_burden_op + d.atrial_burden_percent + "%", "> " + T.burdenWarn + "%", "burden");
  (d.device_notes || []).forEach(function (s) { add("warn", s, "Device message", "note"); });
  var o = { critical: 0, warn: 1, info: 2 };
  return f.sort(function (x, y) { return o[x.level] - o[y.level]; });
}

/* ---------------- Template (the author's wording) ---------------- */
var REASON_TXT = { scheduled: "scheduled transmission.", amplitude_oor: "intrinsic amplitude out of range.", threshold_suspended: "atrial automatic threshold suspended.",
  error_1003: "ERROR CODE 1003.", vt: "VT episodes.", atrial_burden: "atrial burden." };
// Known LATITUDE alerts use the template's wording; any other alert is quoted as written.
function reasonText(d) {
  var seen = {}, out = [];
  (d.device_alerts || []).forEach(function (a) {
    var t = /1003/.test(a) ? "ERROR CODE 1003." : /threshold.*suspend/i.test(a) ? "atrial automatic threshold suspended."
      : /intrinsic amplitude/i.test(a) ? "intrinsic amplitude out of range." : /(V-?Tachy|\bVT\b|ventricular tachy)/i.test(a) ? "VT episodes."
      : /(AT\/AF|atrial (burden|arrhythmia))/i.test(a) ? "atrial burden." : a.replace(/\.?\s*$/, ".").replace(/^[A-Z](?=[a-z])/, function (c) { return c.toLowerCase(); });
    if (!seen[t]) { seen[t] = 1; out.push(t); }
  });
  return out.length ? out.join(" ") : null;
}
var ACTIONS = ["No actions taken", "Site notified by email, report routed to working group", "Cardiologist notified, report routed and Meditech ordered"];

function template(d, flags, T) {
  var inp = function (k, ph, w) { return '<input type="text" class="fill-input ' + (w || "w-long") + '" data-k="' + k + '" placeholder="' + ph + '">'; };
  var val = function (v, k, ph) { return v != null && v !== "" ? '<span class="prefilled">' + esc(v) + "</span>" : inp(k, ph, "w-short"); };
  var pl = function (n, w, many) { return n + " " + (n === 1 ? w : many || w + "s"); };
  var eps = d.episodes || [];
  var by = function (types) { return eps.filter(function (e) { return types.indexOf(e.type) >= 0; }).reduce(function (s, e) { return s + e.count; }, 0); };
  var out = ["Transmission received due to " + (reasonText(d) ? esc(reasonText(d)) :
    '<select class="report-select" data-k="reason">' + ["scheduled transmission.", "patient initiation.", "patient initiation, this is the first transmission"]
      .map(function (r) { return '<option value="' + r + '">' + r + "</option>"; }).join("") + "</select>")];
  var ep = [];
  var row = function (n, what, k) { return '<span class="nw">' + n + " " + what + (n === 1 ? " episode" : " episodes") + " noted, " + inp("det-" + k, "details from the EGM") + "</span>"; };
  var vhr = by(["VT", "VF", "NSVT"]);              // VT, VF and nonsustained V together
  if (vhr) ep.push("<span>" + vhr + " VHR " + (vhr === 1 ? "episode" : "episodes") + " noted, longest episode is " +
    (d.vhr_longest ? val(d.vhr_longest) : inp("vhr-longest", "duration", "w-mid")) + ", " + inp("det-vhr", "details from the EGM") + "</span>");
  var svt = by(["SVT"]);
  if (svt && d.source === "CareLink") ep.push("<span>" + svt + " SVT " + (svt === 1 ? "episode" : "episodes") + " noted, longest episode is " +
    (d.svt_longest ? val(d.svt_longest) : inp("svt-longest", "duration", "w-mid")) + ", " + inp("det-svt", "details from the EGM") + "</span>");
  else if (svt) ep.push(row(svt, "SVT", "svt"));
  var ahr = by(["AHR"]);
  if (ahr) ep.push(ahr + " AHR " + (ahr === 1 ? "episode" : "episodes") + " noted, longest episode lasting " + (d.ahr_longest ? val(d.ahr_longest) : inp("ahr-longest", "duration", "w-mid")));
  if (d.therapies_delivered && d.source !== "CareLink") ep.push('<span class="nw">' + pl(d.therapies_delivered, "therapy", "therapies") + " delivered, " + inp("det-therapy", "details from the EGM") + "</span>");
  out = out.concat(ep.length ? ep : ["No high rate episodes were noted."]);
  if (d.source === "CareLink" && d.icd)
    out.push(d.therapies_delivered ? '<span class="nw">Therapy delivered: ' + inp("det-therapy", "therapy details") + "</span>" : "No therapies delivered");
  // Burden N/R: DDIR says so on the line; VVI(R) has no atrial lead, so the line is left out.
  var mode = (d.device.mode || "").replace(/^AAIR?<=>(DDDR?)$/, "$1");   // MVP mode counts as DDD(R)
  if (d.atrial_burden_percent != null) out.push("Atrial burden: " + val((d.atrial_burden_op || "") + d.atrial_burden_percent) + "%");
  else if (mode === "DDIR") out.push("Atrial burden: DDIR");
  else if (/^DDDR?$/.test(mode)) out.push("Atrial burden: " + val("0") + "%");
  else if (!/^VVIR?$/.test(mode)) out.push("Atrial burden: " + val(null, "burden", "%") + "%");
  var line = function (tag) { return flags.filter(function (f) { return f.tag === tag && f.level !== "info"; }).map(function (f) { return f.title; }).join("; "); };
  var imp = line("imp"), sen = line("sense");
  out.push(imp ? '<span class="flagged">Lead impedance: ' + esc(imp) + "</span>" : d.icd && d.source === "CareLink" ? "Lead and HV impedance stable" : "Lead impedance stable");
  out.push(sen ? '<span class="flagged">Sensing/capture: ' + esc(sen) + "</span>" : "Sensing and capture within range");
  out.push("Estimated battery longevity is " + (d.battery.text ? val(d.battery.text) : val(null, "batt", "#") + " years"));
  out.push("Next appointment with " + (d.siteChoice ? '<select class="report-select" data-k="site">' +
    SITES.map(function (c) { return '<option value="' + c + '"' + (c === d.site ? " selected" : "") + ">" + c + "</option>"; }).join("") + "</select>" : val(d.site, "site", "clinic")));
  var extra = d.device_notes || [];
  if (extra.length) out.push(esc(extra.join(" ")));
  out.push('<select class="report-select" data-k="action">' + ACTIONS.map(function (a) { return '<option value="' + a + '">' + a + "</option>"; }).join("") + "</select>");
  return out.join("<br>");
}

/* ---------------- Panel ---------------- */
var CSS = [
  ":host,.pmr{all:initial;font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#17232b}",
  ".pmr *{box-sizing:border-box}",
  ".pmr .card{background:#fff;border:1px solid #d6dee2;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:12px}",
  ".pmr .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}",
  ".pmr .dev{font-weight:600;font-size:18px}.pmr .sub{color:#5a6b75;font-size:14px}",
  ".pmr .x{border:0;background:none;font-size:26px;cursor:pointer;color:#5a6b75;line-height:1}",
  ".pmr .verdict{font-weight:600;padding:8px 10px;border-radius:6px}",
  ".pmr .v-crit{background:#fbe9ea;color:#b4232c}.pmr .v-warn{background:#fdf1dc;color:#8a5200}.pmr .v-ok{background:#e4f4ea;color:#1f7a4a}",
  ".pmr ul{list-style:none;margin:0;padding:0}.pmr li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid #eef1f3}",
  ".pmr li:last-child{border-bottom:0}.pmr .rule{display:block;color:#5a6b75;font-size:13px}",
  ".pmr .pill{flex:none;width:72px;text-align:center;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 0;border-radius:99px}",
  ".pmr .critical{background:#fbe9ea;color:#b4232c}.pmr .warn{background:#fdf1dc;color:#8a5200}.pmr .info{background:#eceff1;color:#4a5a66}",
  ".pmr .text-block{line-height:2;padding:10px 12px;border:1px solid #d6dee2;border-radius:6px;background:#f6f8f9;outline:none}",
  ".pmr .report-select{font:inherit;font-size:15px;background:#fffdf3;border:1px solid #c9b98a;border-radius:4px;padding:1px 3px;max-width:100%;color:#17232b}",
  ".pmr .report-select.needs{border-color:#b4232c;box-shadow:0 0 0 2px #fbe9ea}",
  ".pmr .fill-input{font:15px ui-monospace,Menlo,Consolas,monospace;background:#fffdf3;border:1px solid #c9b98a;border-radius:4px;padding:1px 5px;color:#17232b}",
  ".pmr .w-short{width:5.5em}.pmr .w-long{width:13em;max-width:100%}.pmr .w-mid{width:8.5em}.pmr .nw{white-space:nowrap}",
  ".pmr .prefilled{box-shadow:inset 0 -2px 0 #0f5e7a}.pmr .flagged{color:#b4232c;font-weight:600}",
  ".pmr .btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
  ".pmr button.b{font:inherit;font-size:15px;padding:7px 14px;border-radius:6px;border:1px solid #d6dee2;background:#fff;cursor:pointer;color:#17232b}",
  ".pmr button.b.p{background:#0f5e7a;border-color:#0f5e7a;color:#fff;font-weight:600}",
  ".pmr button.b:focus-visible,.pmr select:focus-visible,.pmr input:focus-visible{outline:2px solid #0f5e7a;outline-offset:2px}",
  ".pmr .ini{display:flex;align-items:center;gap:8px;font-size:15px;color:#5a6b75}",
  ".pmr .msg{font-size:14px;color:#1f7a4a}.pmr .msg.err{color:#b4232c}",
  ".pmr .tw{overflow-x:auto}.pmr table{border-collapse:collapse;font-size:15px;width:100%}.pmr td,.pmr th{padding:4px 6px;border-bottom:1px solid #eef1f3;text-align:left;white-space:nowrap}",
  ".pmr th{color:#5a6b75;font-weight:500}.pmr tr.hd th{font-size:12px}.pmr .cur{color:#0b5fa5;font-weight:700}.pmr .old{color:#7a8a94;font-weight:400}",
  ".pmr textarea{position:absolute;left:-9999px}"
].join("\n");

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function render(host, d, T, opt) {
  opt = opt || {};
  T = Object.assign({}, DEFAULTS, T || {});
  var flags = d.recognised ? evaluate(d, T) : [];
  var crit = flags.filter(function (f) { return f.level === "critical"; }).length, warn = flags.filter(function (f) { return f.level === "warn"; }).length;
  var vcls = crit ? "v-crit" : warn ? "v-warn" : "v-ok";
  var vtxt = !d.recognised ? "This doesn't look like a LATITUDE Summary or CareLink Current Status page." : crit ? crit + " critical, " + warn + " to review" : warn ? warn + " to review" : "Nothing out of range";
  if (!d.recognised) vcls = "v-warn";
  var cell = function (c, kind) {
    if (c === undefined) return "";
    if (c === null) return "N/R";
    return kind === "amp" ? c.op + c.v + " mV" : kind === "imp" ? c.op + c.v + " Ω" : (c.auto ? "Auto " : "") + c.v + " V @ " + c.pw + " ms";
  };
  var one = d.source === "CareLink";           // CareLink: current values only, no in-office column
  var leadRows = (d.leads || []).map(function (l) {
    var row = "<tr><th>" + (l.coil ? "HV " + l.coil : l.chamber) + "</th>";
    ["amp", "imp", "thr"].forEach(function (k) {
      row += '<td><b class="cur">' + esc(cell(l.daily[k], k) || "—") + "</b></td>" + (one ? "" : '<td class="old">' + esc(cell(l.office[k], k) || "—") + "</td>");
    });
    return row + "</tr>";
  }).join("");
  host.innerHTML = '<style>' + CSS + '</style><div class="pmr"><div class="card">' +
    '<div class="top"><div><div class="dev">' + esc(d.device.model || "Unknown device") + (d.device.mode ? " · " + esc(d.device.mode) : "") + '</div>' +
    '<div class="sub">' + esc([d.patient.name, d.device.serial ? "SN " + d.device.serial : "", d.measured ? (d.source === "CareLink" ? "Interrogated " : "Daily ") + d.measured : "", d.tags.length ? "Tags: " + d.tags.join(" ") : ""].filter(Boolean).join(" · ")) + '</div></div>' +
    (opt.onClose ? '<button class="x" data-a="close" aria-label="Close">×</button>' : "") + '</div>' +
    '<div class="verdict ' + vcls + '">' + esc(vtxt) + '</div>' +
    (flags.length ? "<ul>" + flags.map(function (f) {
      return '<li><span class="pill ' + f.level + '">' + (f.level === "critical" ? "Critical" : f.level === "warn" ? "Review" : "Note") + '</span><span>' + esc(f.title) + '<span class="rule">' + esc(f.rule) + "</span></span></li>";
    }).join("") + "</ul>" : "") +
    (d.recognised ? '<div class="text-block" contenteditable="true" spellcheck="false">' + template(d, flags, T) + '</div>' : "") +
    (d.recognised ? '<label class="ini">Tech initials <input type="text" class="fill-input w-short" data-k="initials" maxlength="12" autocomplete="off"></label>' : "") +
    '<div class="btns"><button class="b p" data-a="copy">Copy report</button>' +
    (d.patient.name ? '<button class="b" data-a="name">Copy name</button>' : "") +
    '<span class="msg" data-k="msg"></span></div>' +
    (leadRows ? '<div class="tw"><table><tr><th></th><th colspan="' + (one ? 1 : 2) + '">Sensing</th><th colspan="' + (one ? 1 : 2) + '">Impedance</th><th colspan="' + (one ? 1 : 2) + '">Threshold</th></tr>' +
      '<tr class="hd"><th></th>' + (one ? '<th class="cur">Current</th>' : '<th class="cur">Daily</th><th class="old">In-office</th>').repeat(3) + "</tr>" + leadRows + "</table></div>" +
      (one ? '<div class="sub"><b class="cur">Interrogated ' + esc(d.interrogated || "") + "</b></div>"
        : '<div class="sub"><b class="cur">Daily ' + esc(d.measured || "") + '</b> (current) · <span class="old">In-office ' + esc(d.office_date || "") + "</span></div>") : "") +
    '<div class="sub">Pacing A ' + (d.pacing_percent.atrial != null ? d.pacing_percent.atrial + "%" : "—") + " · V " + (d.pacing_percent.ventricular != null ? d.pacing_percent.ventricular + "%" : "—") +
    (d.since_reset ? " · counters since " + esc(d.since_reset) : "") + "</div>" +
    "</div></div>";

  var q = function (k) { return host.querySelector('[data-k="' + k + '"]'); };
  // Tech initials: remembered in this browser, pasted under the report after a blank line
  var iniEl = q("initials");
  if (iniEl) {
    try { iniEl.value = localStorage.getItem("pmr.initials") || ""; } catch (e) {}
    iniEl.addEventListener("input", function () { try { localStorage.setItem("pmr.initials", iniEl.value.trim()); } catch (e) {} });
  }
  var msg = function (t, err) { var m = q("msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); };
  host.querySelector(".pmr").addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-a");
    if (!a) return;
    if (a === "close") return opt.onClose();
    if (a === "copy") {
      if (!d.recognised) return;
      var ini = (q("initials") && q("initials").value.trim()) || "";
      copy(host, reportText(host.querySelector(".text-block")) + (ini ? "\n\n" + ini : ""), function (ok) { msg(ok ? "Report copied." : "Copy failed: select the report text and press Ctrl+C.", !ok); });
    }
    if (a === "name") copy(host, lastName(d.patient.name), function (ok) { msg(ok ? "Last name copied for the Paceart search." : "Copy failed.", !ok); });
  });
  return { flags: flags, text: function () { return reportText(host.querySelector(".text-block")); } };
}

// LATITUDE shows "LAST, FIRST"; Paceart searches by last name. Without a comma, take the last word.
function lastName(name) {
  name = String(name || "").trim();
  return name.indexOf(",") >= 0 ? name.split(",")[0].trim() : name.split(/\s+/).pop();
}

function copy(host, text, cb) {
  var fallback = function () {
    var ta = document.createElement("textarea"); ta.value = text;
    (host.querySelector(".pmr") || host).appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove(); cb(ok);
  };
  try { navigator.clipboard.writeText(text).then(function () { cb(true); }, fallback); } catch (e) { fallback(); }
}

function reportText(rootEl) {
  var out = "";
  (function walk(n) {
    if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); return; }
    if (n.nodeType !== 1 || n.hidden || n.tagName === "STYLE") return;
    if (n.tagName === "BR") { out += "\n"; return; }
    if (n.tagName === "DIV" && n !== rootEl) out += "\n";
    if (n.tagName === "SELECT") { out += n.value; return; }
    if (n.tagName === "INPUT") { out += n.value; return; }
    for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
  })(rootEl);
  return out.split("\n").map(function (l) { return l.replace(/ {2,}/g, " ").trim(); }).filter(Boolean).join("\n");
}

/* ---------------- Bookmarklet entry ---------------- */
function pageText(doc) {
  var best = { text: "", doc: doc }, score = function (t) {
    return (/Pace Impedance|Capture Threshold/i.test(t) ? 2 : 0) + (/time to explant|Remaining Longevity|Arrhythmia Episodes/i.test(t) ? 1 : 0);
  };
  (function visit(dc) {
    try {
      var t = dc.body ? dc.body.innerText : "";
      if (score(t) > score(best.text) || (!best.text && t.length)) best = { text: t, doc: dc };
      var fr = dc.querySelectorAll("iframe,frame");
      for (var i = 0; i < fr.length; i++) { try { if (fr[i].contentDocument) visit(fr[i].contentDocument); } catch (e) {} }
    } catch (e) {}
  })(doc);
  return best;
}

// Saved Episodes/Events-tab results, kept only for the same device and transmission
var EP_KEY = "pmr.tab.episodes";
function epKey(d) { return d.source + "|" + (d.device.serial || "") + "|" + (d.interrogated || ""); }
function saveEpisodes(d) { try { localStorage.setItem(EP_KEY, JSON.stringify({ k: epKey(d), ahr: d.ahr_longest, svt: d.svt_longest, vhr: d.vhr_longest, t: Date.now() })); } catch (e) {} }
function savedEpisodes(d) {
  try { var v = JSON.parse(localStorage.getItem(EP_KEY) || "null"); return v && v.k === epKey(d) && Date.now() - v.t < 12 * 3600e3 ? v : null; } catch (e) { return null; }
}

// Load another tab (a same-site link) in an invisible frame and read its text; the frame must be laid out for innerText
function loadTab(doc, linkText, ready, cb) {
  var a = [].filter.call(doc.querySelectorAll("a"), function (x) { return linkText.test(x.textContent) && /^https?:/.test(x.href) && x.href.indexOf(location.origin) === 0; })[0];
  if (!a) return cb(null);
  var f = document.createElement("iframe"), done = false, t0 = Date.now();
  f.style.cssText = "position:fixed;left:-20000px;top:0;width:1280px;height:900px;opacity:0;pointer-events:none";
  var finish = function (v) { if (done) return; done = true; f.remove(); cb(v); };
  var poll = function () {
    if (done) return;
    try {
      var t = f.contentDocument && f.contentDocument.body ? f.contentDocument.body.innerText : "";
      if (ready.test(t)) return finish(t);
    } catch (e) { return finish(null); }
    if (Date.now() - t0 > 15000) return finish(null);
    setTimeout(poll, 400);
  };
  f.onload = poll;
  f.src = a.href;
  document.body.appendChild(f);
  setTimeout(poll, 1500);
}

// Which patient transmission is on screen: device serial + transmission date ("" when none)
function allText(doc) {
  var out = "";
  (function visit(dc) {
    try {
      out += (dc.body ? dc.body.innerText : "") + "\n";
      var fr = dc.querySelectorAll("iframe,frame");
      for (var i = 0; i < fr.length; i++) { try { if (fr[i].contentDocument) visit(fr[i].contentDocument); } catch (e) {} }
    } catch (e) {}
  })(doc);
  return out;
}
function pageIdent(text) {
  var m = text.match(/Serial Number:\s*(\S+)/i), t = text.match(/Date of Interrogation:\s*(\S+ \S+)/i);
  if (m) return "CL|" + m[1] + "|" + (t ? t[1] : "");
  m = text.match(/Device:[^\n]*?\/\s*(\d{4,})/i); t = text.match(/Latest Device Transmission:\s*(\d{1,2} \w{3} \d{4}(?: \d{1,2}:\d{2})?)/i);
  return m ? "LAT|" + m[1] + "|" + (t ? t[1] : "") : "";
}

var TAB = {
  CareLink: { link: /^\s*Episodes\s*$/, ready: /Arrhythmia Episodes/i, back: "Quick Look II", name: "Episodes",
    read: function (t) { return parseCarelinkEpisodes(lines(t)); } },
  LATITUDE: { link: /^\s*Events\s*$/, ready: /Arrhythmia Logbook/i, back: "Summary", name: "Events",
    read: function (t) { return parseLatitudeEvents(lines(t)); } }
};
var GROUP_NAME = { ahr: "AT/AF", svt: "SVT / Fast A&amp;V", vhr: "VHR" };

function openOverlay(T) {
  var old = document.getElementById("pmremote-overlay");
  if (old) old.remove();
  var pg = pageText(document), d = parse(pg.text), tab = TAB[d.source];
  var box = document.createElement("div");
  box.id = "pmremote-overlay";
  var side = d.source === "CareLink" ? "right" : "left";
  box.style.cssText = "position:fixed;top:12px;" + side + ":12px;width:min(600px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.25);border-radius:8px";
  document.documentElement.appendChild(box);
  // Some sites zoom the whole page; undo it so the panel is the same size everywhere
  var probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:100px;height:1px;visibility:hidden";
  box.appendChild(probe);
  var zoom = probe.getBoundingClientRect().width / 100;
  probe.remove();
  if (zoom && Math.abs(zoom - 1) > 0.02) box.style.zoom = String(1 / zoom);
  var host = box.attachShadow ? box.attachShadow({ mode: "open" }) : box;
  var watch = null;
  var close = function () { if (watch) clearInterval(watch); box.remove(); };

  // Close when another patient or transmission is opened, or when no patient is on screen for ~5 s
  var ident = pageIdent(allText(document)), missing = 0;
  if (ident) watch = setInterval(function () {
    if (!box.isConnected) return clearInterval(watch);
    var now = pageIdent(allText(document));
    if (now && now !== ident) return close();
    missing = now ? 0 : missing + 1;
    if (missing >= 3) close();
  }, 1700);

  if (d.episodes_page || d.events_page) {
    // Clicked on the Episodes/Events tab: remember the longest episodes for this transmission
    var msgs = [];
    ["vhr", "svt", "ahr"].forEach(function (g) {
      if (d[g + "_longest"]) msgs.push("Longest " + GROUP_NAME[g] + " episode: " + esc(d[g + "_longest"]) + " (of " + d[g + "_longest_listed"] + " listed).");
    });
    if (msgs.length) saveEpisodes(d);
    host.innerHTML = "<style>" + CSS + '</style><div class="pmr"><div class="card"><div class="top"><div class="dev">' + tab.name + '</div><button class="x" data-a="close" aria-label="Close">×</button></div>' +
      '<div class="verdict ' + (msgs.length ? "v-ok" : "v-warn") + '">' + (msgs.length ? msgs.join("<br>") + "<br>Saved: return to " + tab.back + " and press PM Remote again."
        : "No episodes found on this page.") + "</div></div></div>";
    host.querySelector('[data-a="close"]').onclick = close;
    return;
  }
  var sv = tab ? savedEpisodes(d) : null;
  if (sv) ["ahr", "svt", "vhr"].forEach(function (g) { d[g + "_longest"] = d[g + "_longest"] || sv[g]; });
  render(host, d, T, { onClose: close });
  if (!tab) return;
  // Fill the longest-episode boxes from the other tab, read in the background
  var groups = d.source === "CareLink" ? ["ahr", "svt", "vhr"] : ["vhr"];
  var slots = {};
  groups.forEach(function (g) { var el = host.querySelector('[data-k="' + g + '-longest"]'); if (el) { slots[g] = el; el.placeholder = "reading " + tab.name + "…"; } });
  if (!Object.keys(slots).length) return;
  loadTab(pg.doc, tab.link, tab.ready, function (t) {
    var e = t ? tab.read(t) : null;
    for (var g in slots) {
      var sl = slots[g];
      if (!sl.isConnected || sl.value) continue;
      var v = e && e[g] ? episodeText(e[g], g !== "ahr") : null;
      if (v) { sl.value = v; sl.classList.add("prefilled"); sl.style.width = Math.max(8.5, v.length * 0.66 + 1) + "em"; }
      else sl.placeholder = "open " + tab.name + ", press PM Remote";
    }
  });
}

var api = { parseLatitudeEvents: parseLatitudeEvents, pageIdent: pageIdent, parse: parse, parseCarelink: parseCarelink, cellSeconds: cellSeconds, lastName: lastName, durSeconds: durSeconds, fmtDur: fmtDur, SITES: SITES, DEFAULTS: DEFAULTS, THR_LABELS: THR_LABELS, lines: lines, parseLatitude: parseLatitude, evaluate: evaluate, render: render, reportText: reportText, openOverlay: openOverlay };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PMRemote = api;
})(typeof window !== "undefined" ? window : this);
