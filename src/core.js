/* PM Remote core: LATITUDE text parser, threshold rules, report templates and the review panel.
   No network, no AI: everything runs in the browser (or in Node for tests). */
(function (root) {
"use strict";

var SITES = ["LMH", "JPOCSC", "SMH", "ERH", "DH", "PAH", "RMH", "ARH"];
var DEFAULTS = { impLow: 200, impHigh: 1000, impChangePct: 20, pMin: 1.0, pIgnoreBurden: 50, rMin: 5, thrMax: 1.5, thrDelta: 0.25, burdenWarn: 20, batteryWarn: 1 };
var THR_LABELS = [
  ["impLow", "Pacing lead impedance low (Ω)"], ["impHigh", "Pacing lead impedance high (Ω)"],
  ["impChangePct", "Impedance change since last check (%)"], ["pMin", "P wave below (mV)"], ["rMin", "R wave below (mV)"],
  ["thrMax", "Capture threshold above (V)"], ["thrDelta", "…unless within (V) of last check"],
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
    for (var i = a0 + 1; i < L.length; i++) {
      if (/^(For Technical Support|Leads\b)/i.test(L[i])) break;
      if (new RegExp("^" + DATE + "(?: \\d{1,2}:\\d{2})?$").test(L[i])) continue;
      d.device_alerts.push(L[i]);
    }
  }

  // Leads: track the chamber header, then read each measurement row
  var CH = { "atrial": "RA", "ventricular": "RV", "right ventricular": "RV", "left ventricular": "LV", "rv": "RV", "lv": "LV" };
  var LAB = [["intrinsic amplitude", "amp"], ["pace impedance", "imp"], ["pace threshold", "thr"], ["shock impedance", "shock"], ["high voltage impedance", "shock"]];
  var isVal = function (s) { return /^(\(|N\/R|Auto\b|[<>]?\s*\d|@|ms\b)/i.test(s); };
  var chamber = null, leads = {}, order = [];
  for (var k = 0; k < L.length; k++) {
    var line = L[k].replace(/^[^A-Za-z(]+/, "");
    var low = line.toLowerCase();
    if (CH[low]) { chamber = CH[low]; continue; }
    var lab = null;
    for (var q = 0; q < LAB.length; q++) if (low.indexOf(LAB[q][0]) === 0) { lab = LAB[q]; break; }
    if (!lab || (!chamber && lab[1] !== "shock")) continue;
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
    if (cells.length >= 2) { ld.office[kind] = cells[0]; ld.daily[kind] = cells[1]; }
    else if (cells.length === 1) ld.daily[kind] = cells[0];
  }
  Object.keys(leads).forEach(function (c) {
    var l = leads[c], cur = function (k) { return l.daily[k] || l.office[k] || null; };
    var am = cur("amp"), im = cur("imp"), th = cur("thr");
    if (am) { l.amplitude_mv = am.v; l.amplitude_op = am.op; }
    if (im) { l.impedance_ohm = im.v; if (l.daily.imp && l.office.imp) l.previous_impedance_ohm = l.office.imp.v; }
    if (th) { l.threshold_v = th.v; l.threshold_pw_ms = th.pw; if (l.daily.thr && l.office.thr) l.previous_threshold_v = l.office.thr.v; }
  });
  d.leads = order.map(function (c) { return leads[c]; });

  // Battery
  var bm = J.match(/time to explant:?\s*([<>]?\s*\d+(?:\.\d+)?)\s*(years?|months?)/i);
  if (bm) d.battery.years = Math.round(num(bm[1]) / (/^month/i.test(bm[2]) ? 12 : 1) * 10) / 10;
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
  }

  // AT/AF burden and event counts
  var burden = J.match(/AT\/AF(?:\s*\([^)]*\))?\s+([<>]?)\s*(\d+(?:\.\d+)?|N\/R)\s*%/i);
  d.atrial_burden_percent = burden && /\d/.test(burden[2]) ? +burden[2] : null;
  d.atrial_burden_op = burden && d.atrial_burden_percent != null ? burden[1] : "";
  var cnt = function (re) { var mm = J.match(re); return mm && /\d/.test(mm[1]) ? +mm[1] : null; };
  var ep = [
    ["VT", cnt(/(?<![A-Za-z])VT Episodes\s*(?:\([^)]*\))?\s+(\d+|N\/R)/i), "VT episodes (V>A)"],
    ["VF", cnt(/(?<![A-Za-z])VF Episodes\s*(?:\([^)]*\))?\s+(\d+|N\/R)/i), "VF episodes"],
    ["NSVT", cnt(/Nonsustained\s*V\s*Episodes\s+(\d+|N\/R)/i), "Nonsustained V episodes"],
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
  // The overview lists "Longest (date) / Avg V Rate, Duration (hh:mm:ss) / 69 min-1, 00:00:07": use it when present.
  var lg = (ov >= 0 ? J.slice(ov, ov + 900) : "").match(/(?:^|\n)Longest\b[^\n]*\n[\s\S]{0,160}?Duration[\s\S]{0,80}?(\d+:\d{2}:\d{2})/i);
  if (lg) d.ahr_longest = fmtDur(durSeconds(lg[1])) || d.ahr_longest;
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
  return d;
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
// Round to the nearest hour, minute or second, whichever applies.
function fmtDur(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  var pl = function (n, w) { return n + " " + w + (n === 1 ? "" : "s"); };
  if (sec < 59.5) return pl(Math.max(1, Math.round(sec)), "second");
  var m = Math.round(sec / 60);
  if (m < 60) return pl(m, "minute");
  return pl(Math.round(sec / 3600), "hour");
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

/* ---------------- Rules ---------------- */

function evaluate(d, T) {
  var f = [];
  var add = function (level, title, rule, tag) { f.push({ level: level, title: title, rule: rule, tag: tag }); };
  var b = d.battery || {};
  if (b.status) add("critical", "Battery " + b.status, "Battery at replacement indicator", "batt");
  else if (b.years != null && b.years <= T.batteryWarn) add("warn", "Battery " + b.years + " years to explant", "≤ " + T.batteryWarn + " years", "batt");
  else if (b.years == null) add("info", "Battery longevity not found", "Check by hand", "batt");
  (d.leads || []).forEach(function (l) {
    var ch = l.chamber, hv = ch === "HV", lo = hv ? 20 : T.impLow, hi = hv ? 150 : T.impHigh;
    var z = l.impedance_ohm, zp = l.previous_impedance_ohm;
    if (z != null && (z < lo || z > hi)) add("critical", ch + " impedance " + z + " Ω", "Outside " + lo + "–" + hi + " Ω", "imp");
    if (z != null && zp) {
      var pct = Math.round(Math.abs(z - zp) / zp * 100);
      if (pct > T.impChangePct) add("warn", ch + " impedance " + (z > zp ? "rose" : "fell") + " " + zp + " → " + z + " Ω (" + pct + "%)", "Change > " + T.impChangePct + "% since last check", "imp");
    }
    var a = l.amplitude_mv;
    if (a != null && l.amplitude_op !== ">") {
      var inAF = d.device.mode === "DDIR" || (d.atrial_burden_percent != null && d.atrial_burden_op !== "<" && d.atrial_burden_percent > T.pIgnoreBurden);
      if (ch === "RA" && a < T.pMin && !inAF) add("warn", "P wave " + a + " mV", "< " + T.pMin + " mV (not DDIR, burden ≤ " + T.pIgnoreBurden + "%)", "sense");
      if ((ch === "RV" || ch === "LV") && a < T.rMin) add("warn", ch + " R wave " + a + " mV", "< " + T.rMin + " mV", "sense");
    }
    var tv = l.threshold_v, tp = l.previous_threshold_v;
    if (tv != null && !hv && tv > T.thrMax && !(tp != null && Math.abs(tv - tp) <= T.thrDelta + 1e-9))
      add("warn", ch + " threshold " + tv + " V @ " + l.threshold_pw_ms + " ms" + (tp != null ? " (last check " + tp + " V)" : ""),
        "> " + T.thrMax + " V and not within " + T.thrDelta + " V of last check", "sense");
  });
  if (!d.site) add("warn", "No clinic in search tags", "Expected one of " + SITES.join(", ") + (d.tags.length ? "; tags: " + d.tags.join(" ") : ""), "site");
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
  [["VHR", ["VT", "VF"]], ["NS-VT", ["NSVT"]], ["SVT", ["SVT"]]].forEach(function (x) {
    var n = by(x[1]); if (n) ep.push('<span class="nw">' + pl(n, "episode") + " of " + x[0] + " noted, " + inp("det-" + x[0], "details from the EGM") + "</span>");
  });
  var ahr = by(["AHR"]);
  if (ahr) ep.push(pl(ahr, "episode") + " of AHR noted, longest episode lasting " + val(d.ahr_longest, "ahr-longest", "duration"));
  if (d.therapies_delivered) ep.push('<span class="nw">' + pl(d.therapies_delivered, "therapy", "therapies") + " delivered, " + inp("det-therapy", "details from the EGM") + "</span>");
  var af48 = by(["AF48"]);
  if (af48) ep.push('<span class="nw">' + pl(af48, "atrial episode") + " longer than 48 hours noted, " + inp("det-af48", "details from the EGM") + "</span>");
  out = out.concat(ep.length ? ep : ["No high rate episodes were noted."]);
  // Burden N/R: DDIR says so on the line; VVI(R) has no atrial lead, so the line is left out.
  var mode = d.device.mode || "";
  if (d.atrial_burden_percent != null) out.push("Atrial burden: " + val((d.atrial_burden_op || "") + d.atrial_burden_percent) + "%");
  else if (mode === "DDIR") out.push("Atrial burden: DDIR");
  else if (!/^VVIR?$/.test(mode)) out.push("Atrial burden: " + val(null, "burden", "%") + "%");
  var line = function (tag) { return flags.filter(function (f) { return f.tag === tag && f.level !== "info"; }).map(function (f) { return f.title; }).join("; "); };
  var imp = line("imp"), sen = line("sense");
  out.push(imp ? '<span class="flagged">Lead impedance: ' + esc(imp) + "</span>" : "Lead impedance stable");
  out.push(sen ? '<span class="flagged">Sensing/capture: ' + esc(sen) + "</span>" : "Sensing and capture within range");
  out.push("Estimated battery longevity is " + val(d.battery.years, "batt", "#") + " years");
  out.push("Next appointment with " + val(d.site, "site", "clinic"));
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
  ".pmr .w-short{width:5.5em}.pmr .w-long{width:13em;max-width:100%}.pmr .nw{white-space:nowrap}",
  ".pmr .prefilled{box-shadow:inset 0 -2px 0 #0f5e7a}.pmr .flagged{color:#b4232c;font-weight:600}",
  ".pmr .btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
  ".pmr button.b{font:inherit;font-size:15px;padding:7px 14px;border-radius:6px;border:1px solid #d6dee2;background:#fff;cursor:pointer;color:#17232b}",
  ".pmr button.b.p{background:#0f5e7a;border-color:#0f5e7a;color:#fff;font-weight:600}",
  ".pmr button.b:focus-visible,.pmr select:focus-visible,.pmr input:focus-visible{outline:2px solid #0f5e7a;outline-offset:2px}",
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
  var vtxt = !d.recognised ? "This doesn't look like a LATITUDE Summary page." : crit ? crit + " critical, " + warn + " to review" : warn ? warn + " to review" : "Nothing out of range";
  if (!d.recognised) vcls = "v-warn";
  var cell = function (c, kind) {
    if (c === undefined) return "";
    if (c === null) return "N/R";
    return kind === "amp" ? c.op + c.v + " mV" : kind === "imp" ? c.op + c.v + " Ω" : (c.auto ? "Auto " : "") + c.v + " V @ " + c.pw + " ms";
  };
  var leadRows = (d.leads || []).map(function (l) {
    var row = "<tr><th>" + l.chamber + "</th>";
    ["amp", "imp", "thr"].forEach(function (k) {
      row += '<td><b class="cur">' + esc(cell(l.daily[k], k) || "—") + '</b></td><td class="old">' + esc(cell(l.office[k], k) || "—") + "</td>";
    });
    return row + "</tr>";
  }).join("");
  host.innerHTML = '<style>' + CSS + '</style><div class="pmr"><div class="card">' +
    '<div class="top"><div><div class="dev">' + esc(d.device.model || "Unknown device") + (d.device.mode ? " · " + esc(d.device.mode) : "") + '</div>' +
    '<div class="sub">' + esc([d.patient.name, d.device.serial ? "SN " + d.device.serial : "", d.measured ? "Daily " + d.measured : "", d.tags.length ? "Tags: " + d.tags.join(" ") : ""].filter(Boolean).join(" · ")) + '</div></div>' +
    (opt.onClose ? '<button class="x" data-a="close" aria-label="Close">×</button>' : "") + '</div>' +
    '<div class="verdict ' + vcls + '">' + esc(vtxt) + '</div>' +
    (flags.length ? "<ul>" + flags.map(function (f) {
      return '<li><span class="pill ' + f.level + '">' + (f.level === "critical" ? "Critical" : f.level === "warn" ? "Review" : "Note") + '</span><span>' + esc(f.title) + '<span class="rule">' + esc(f.rule) + "</span></span></li>";
    }).join("") + "</ul>" : "") +
    (d.recognised ? '<div class="text-block" contenteditable="true" spellcheck="false">' + template(d, flags, T) + '</div>' : "") +
    '<div class="btns"><button class="b p" data-a="copy">Copy report</button>' +
    (d.patient.name ? '<button class="b" data-a="name">Copy name</button>' : "") +
    (d.device.serial ? '<button class="b" data-a="serial">Copy serial</button>' : "") +
    '<span class="msg" data-k="msg"></span></div>' +
    (leadRows ? '<div class="tw"><table><tr><th></th><th colspan="2">Sensing</th><th colspan="2">Impedance</th><th colspan="2">Threshold</th></tr>' +
      '<tr class="hd"><th></th>' + '<th class="cur">Daily</th><th class="old">In-office</th>'.repeat(3) + "</tr>" + leadRows + "</table></div>" +
      '<div class="sub"><b class="cur">Daily</b> ' + esc(d.measured || "") + ' (current) · <span class="old">In-office ' + esc(d.office_date || "") + "</span></div>" : "") +
    '<div class="sub">Pacing A ' + (d.pacing_percent.atrial != null ? d.pacing_percent.atrial + "%" : "—") + " · V " + (d.pacing_percent.ventricular != null ? d.pacing_percent.ventricular + "%" : "—") +
    (d.since_reset ? " · counters since " + esc(d.since_reset) : "") + "</div>" +
    "</div></div>";

  var q = function (k) { return host.querySelector('[data-k="' + k + '"]'); };
  var msg = function (t, err) { var m = q("msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); };
  host.querySelector(".pmr").addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-a");
    if (!a) return;
    if (a === "close") return opt.onClose();
    if (a === "copy") {
      if (!d.recognised) return;
      copy(host, reportText(host.querySelector(".text-block")), function (ok) { msg(ok ? "Report copied." : "Copy failed: select the report text and press Ctrl+C.", !ok); });
    }
    if (a === "name") copy(host, d.patient.name, function (ok) { msg(ok ? "Name copied for the Paceart search." : "Copy failed.", !ok); });
    if (a === "serial") copy(host, d.device.serial, function (ok) { msg(ok ? "Serial copied for the Paceart search." : "Copy failed.", !ok); });
  });
  return { flags: flags, text: function () { return reportText(host.querySelector(".text-block")); } };
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
  var best = "", score = function (t) { return (/Pace Impedance/i.test(t) ? 2 : 0) + (/time to explant/i.test(t) ? 1 : 0); };
  (function visit(dc) {
    try {
      var t = dc.body ? dc.body.innerText : "";
      if (score(t) > score(best) || (score(t) === score(best) && t.length > best.length && !best)) best = t;
      var fr = dc.querySelectorAll("iframe,frame");
      for (var i = 0; i < fr.length; i++) { try { if (fr[i].contentDocument) visit(fr[i].contentDocument); } catch (e) {} }
    } catch (e) {}
  })(doc);
  return best;
}

function openOverlay(T) {
  var old = document.getElementById("pmremote-overlay");
  if (old) old.remove();
  var d = parseLatitude(pageText(document));
  var box = document.createElement("div");
  box.id = "pmremote-overlay";
  box.style.cssText = "position:fixed;top:12px;left:12px;width:min(600px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.25);border-radius:8px";
  document.body.appendChild(box);
  var host = box.attachShadow ? box.attachShadow({ mode: "open" }) : box;
  render(host, d, T, { onClose: function () { box.remove(); } });
}

var api = { durSeconds: durSeconds, fmtDur: fmtDur, SITES: SITES, DEFAULTS: DEFAULTS, THR_LABELS: THR_LABELS, lines: lines, parseLatitude: parseLatitude, evaluate: evaluate, render: render, reportText: reportText, openOverlay: openOverlay };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PMRemote = api;
})(typeof window !== "undefined" ? window : this);
