/* PM Remote core: LATITUDE text parser, threshold rules, report templates and the review panel.
   No network, no AI: everything runs in the browser (or in Node for tests). */
(function (root) {
"use strict";

var SITES = ["JPOCSC", "PAH", "DH", "RMH", "ERH", "LMH"];
var DEFAULTS = { impLow: 200, impHigh: 2000, impChangePct: 30, pMin: 1.5, rMin: 5, thrMax: 2.5, vpMax: 40, burdenWarn: 1, batteryWarn: 1, site: "JPOCSC" };
var THR_LABELS = [
  ["impLow", "Pacing lead impedance low (Ω)"], ["impHigh", "Pacing lead impedance high (Ω)"],
  ["impChangePct", "Impedance change vs in-office (%)"], ["pMin", "P wave below (mV)"], ["rMin", "R wave below (mV)"],
  ["thrMax", "Capture threshold above (V)"], ["vpMax", "Ventricular pacing above (%)"],
  ["burdenWarn", "AT/AF burden at or above (%)"], ["batteryWarn", "Battery at or below (years)"]
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
  var dev = grab(/Device:\s*([^\n]+(?:\n[^\n:]*\/\s*\d+)?)/i);
  if (dev) {
    dev = dev.replace(/\n/g, " ");
    var sm = dev.match(/^(.*?)\s*\/\s*(\d+)\s*$/);
    d.device.model = sm ? sm[1] : dev;
    d.device.serial = sm ? sm[2] : null;
  }
  var tags = grab(/Search Tags:\s*([^\n]+)/i);
  if (tags) { tags = tags.replace(/Monitoring Status.*$/i, "").trim(); d.tags = tags.split(/\s+/); }
  d.site = SITES.filter(function (s) { return d.tags.indexOf(s) >= 0; })[0] || null;
  d.advisory = d.tags.indexOf("ADVISORY") >= 0;
  d.measured = grab(new RegExp("Most Recent\\s+Daily\\s+Measurement\\s*\\(?(" + DATE + ")", "i"));
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
    var m, v = [];
    if (lab[1] === "amp") {
      var re = /([<>]?)\s*(\d+(?:\.\d+)?)\s*mV/g;
      while ((m = re.exec(clean))) v.push({ v: +m[2], op: m[1] });
      if (v.length) { ld.amplitude_mv = v[v.length - 1].v; ld.amplitude_op = v[v.length - 1].op; }
    } else if (lab[1] === "imp" || lab[1] === "shock") {
      var re2 = /([<>]?)\s*(\d+(?:\.\d+)?)\s*(?:Ω|ohms?\b)/gi;
      while ((m = re2.exec(clean))) v.push(+m[2]);
      if (v.length) { ld.impedance_ohm = v[v.length - 1]; if (v.length > 1) ld.previous_impedance_ohm = v[0]; }
    } else if (lab[1] === "thr") {
      var re3 = /(Auto\s*)?(\d+(?:\.\d+)?)\s*V\s*@\s*(\d+(?:\.\d+)?)\s*ms/gi;
      while ((m = re3.exec(clean))) v.push(m);
      if (v.length) { var t = v[v.length - 1]; ld.threshold_v = +t[2]; ld.threshold_pw_ms = +t[3]; }
    }
  }
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
  var burden = J.match(/AT\/AF(?:\s*\([^)]*\))?\s+(\d+(?:\.\d+)?|N\/R)\s*%/i);
  d.atrial_burden_percent = burden && /\d/.test(burden[1]) ? +burden[1] : null;
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
  var shocks = cnt(/Shocks?(?: Delivered)?\s+(\d+)/i), atp = cnt(/ATP(?: Delivered| Therapies)?\s+(\d+)/i);
  d.therapies_delivered = (shocks || 0) + (atp || 0) || null;

  // Device messages worth reading (safety mode, disabled sensors, suspended tests)
  var seen = {};
  L.forEach(function (s) {
    if (/(disabled|suspended|safety (mode|core)|failed|failure|exceeded|reverted)/i.test(s) && s.length < 220 && !seen[s] && d.device_alerts.indexOf(s) < 0) { seen[s] = 1; d.device_notes.push(s); }
  });

  // Reason for transmission from the alert text
  var at = d.device_alerts.join(" ");
  d.reason = /1003/.test(at) ? "error_1003" : /threshold.*suspend/i.test(at) ? "threshold_suspended" : /intrinsic amplitude/i.test(at) ? "amplitude_oor"
    : /(V-?Tachy|VT\b|ventricular tachy)/i.test(at) ? "vt" : /(AT\/AF|atrial (burden|arrhythmia))/i.test(at) ? "atrial_burden" : "scheduled";
  d.recognised = d.leads.length > 0 || d.battery.years != null;
  return d;
}

/* ---------------- Rules ---------------- */
var LEVEL = { VT: "critical", VF: "critical", NSVT: "warn", SVT: "warn", AHR: "warn", AF48: "warn" };

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
      if (pct > T.impChangePct) add("warn", ch + " impedance " + zp + " → " + z + " Ω (" + pct + "%)", "Change > " + T.impChangePct + "% from in-office", "imp");
    }
    var a = l.amplitude_mv;
    if (a != null && l.amplitude_op !== ">") {
      if (ch === "RA" && a < T.pMin) add("warn", "P wave " + a + " mV", "< " + T.pMin + " mV", "sense");
      if ((ch === "RV" || ch === "LV") && a < T.rMin) add("warn", ch + " R wave " + a + " mV", "< " + T.rMin + " mV", "sense");
    }
    if (l.threshold_v != null && !hv && l.threshold_v > T.thrMax) add("warn", ch + " threshold " + l.threshold_v + " V @ " + l.threshold_pw_ms + " ms", "> " + T.thrMax + " V", "sense");
  });
  var vp = (d.pacing_percent || {}).ventricular;
  if (vp != null && vp > T.vpMax) add("warn", "Ventricular pacing " + vp + "%", "> " + T.vpMax + "%", "vp");
  if (d.atrial_burden_percent != null && d.atrial_burden_percent >= T.burdenWarn) add("warn", "AT/AF burden " + d.atrial_burden_percent + "%", "≥ " + T.burdenWarn + "%", "burden");
  (d.episodes || []).forEach(function (e) { add(LEVEL[e.type] || "warn", e.count + " × " + e.label, "Since last reset" + (d.since_reset ? " (" + d.since_reset + ")" : ""), "ep"); });
  if (d.therapies_delivered) add("critical", d.therapies_delivered + " therapies delivered", "Any delivered therapy", "ep");
  (d.device_alerts || []).forEach(function (s) { add("warn", "Alert: " + s, "LATITUDE alert", "alert"); });
  (d.device_notes || []).forEach(function (s) { add("warn", s, "Device message", "note"); });
  if (d.advisory) add("info", "Advisory patient (search tag)", "Tags: " + d.tags.join(" "), "tag");
  var o = { critical: 0, warn: 1, info: 2 };
  return f.sort(function (x, y) { return o[x.level] - o[y.level]; });
}

/* ---------------- Templates (the author's wording) ---------------- */
function opts(list) { return list.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + "</option>"; }).join(""); }
var REMOTE = function () {
  return 'Transmission received due to <select class="report-select" data-k="reason">' + opts([
    ["scheduled transmission.", "Scheduled"], ["patient initiation, this is the first transmission", "First transmission"], ["patient initiation.", "Patient initiation"],
    ["atrial burden.", "Atrial burden"], ["VT episodes.", "VT"], ["intrinsic amplitude out of range.", "Amplitude OOR"],
    ["atrial automatic threshold suspended.", "Threshold suspended"], ["ERROR CODE 1003.", "Error code 1003"], ["", "None"]]) + "</select><br>" +
    '<span data-k="epcount-wrap"><input type="text" class="fill-input w-short" data-k="epcount" placeholder="Count"> </span><select class="report-select" data-k="episodes">' + opts([
    ["No high rate episodes were noted.", "No episodes"], ["episodes of AHR noted, ", "AHR"], ["episodes of VHR noted, ", "VHR"],
    ["episodes of NS-VT noted, ", "NS-VT"], ["episodes of SVT noted, ", "SVT"]]) + '</select><span data-k="epdetail-wrap"><input type="text" class="fill-input w-long" data-k="epdetail" placeholder="details"></span><br>' +
    'Atrial burden: <input type="text" class="fill-input w-short" data-k="burden" value="0">% <br>' +
    '<span class="autoline" data-k="imp">Lead impedance stable</span> <br>' +
    '<span class="autoline" data-k="sense">Sensing and capture within range</span> <br>' +
    'Estimated battery longevity is <input type="text" class="fill-input w-short" data-k="batt" placeholder="# years"> years <br>' +
    'Next appointment with <select class="report-select" data-k="site">' + opts(SITES.map(function (s) { return [s, s]; })) + "</select><br>" +
    '<span data-k="comment-wrap"><span class="autoline" data-k="comment"></span><br></span>' +
    '<select class="report-select" data-k="action">' + opts([["", "Choose action…"], ["No actions taken", "No actions"],
    ["Site notified by email, report routed to working group", "Site notified"], ["Cardiologist notified, report routed and Meditech ordered", "Cardiologist notified"]]) + "</select>";
};
var REASON_OPT = { scheduled: "scheduled transmission.", amplitude_oor: "intrinsic amplitude out of range.", threshold_suspended: "atrial automatic threshold suspended.",
  error_1003: "ERROR CODE 1003.", vt: "VT episodes.", atrial_burden: "atrial burden." };

/* ---------------- Panel ---------------- */
var CSS = [
  ":host,.pmr{all:initial;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#17232b}",
  ".pmr *{box-sizing:border-box}",
  ".pmr .card{background:#fff;border:1px solid #d6dee2;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:12px}",
  ".pmr .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}",
  ".pmr .dev{font-weight:600;font-size:15px}.pmr .sub{color:#5a6b75;font-size:12px}",
  ".pmr .x{border:0;background:none;font-size:20px;cursor:pointer;color:#5a6b75;line-height:1}",
  ".pmr .verdict{font-weight:600;padding:8px 10px;border-radius:6px}",
  ".pmr .v-crit{background:#fbe9ea;color:#b4232c}.pmr .v-warn{background:#fdf1dc;color:#8a5200}.pmr .v-ok{background:#e4f4ea;color:#1f7a4a}",
  ".pmr ul{list-style:none;margin:0;padding:0}.pmr li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid #eef1f3}",
  ".pmr li:last-child{border-bottom:0}.pmr .rule{display:block;color:#5a6b75;font-size:11px}",
  ".pmr .pill{flex:none;width:62px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 0;border-radius:99px}",
  ".pmr .critical{background:#fbe9ea;color:#b4232c}.pmr .warn{background:#fdf1dc;color:#8a5200}.pmr .info{background:#eceff1;color:#4a5a66}",
  ".pmr .text-block{line-height:2;padding:10px 12px;border:1px solid #d6dee2;border-radius:6px;background:#f6f8f9;outline:none}",
  ".pmr .report-select{font:inherit;font-size:13px;background:#fffdf3;border:1px solid #c9b98a;border-radius:4px;padding:1px 3px;max-width:100%;color:#17232b}",
  ".pmr .report-select.needs{border-color:#b4232c;box-shadow:0 0 0 2px #fbe9ea}",
  ".pmr .fill-input{font:13px ui-monospace,Menlo,Consolas,monospace;background:#fffdf3;border:1px solid #c9b98a;border-radius:4px;padding:1px 5px;color:#17232b}",
  ".pmr .w-short{width:5.5em}.pmr .w-long{width:min(18em,100%)}",
  ".pmr .prefilled{box-shadow:inset 0 -2px 0 #0f5e7a}.pmr .flagged{color:#b4232c;font-weight:600}",
  ".pmr .btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
  ".pmr button.b{font:inherit;font-size:13px;padding:6px 12px;border-radius:6px;border:1px solid #d6dee2;background:#fff;cursor:pointer;color:#17232b}",
  ".pmr button.b.p{background:#0f5e7a;border-color:#0f5e7a;color:#fff;font-weight:600}",
  ".pmr button.b:focus-visible,.pmr select:focus-visible,.pmr input:focus-visible{outline:2px solid #0f5e7a;outline-offset:2px}",
  ".pmr .msg{font-size:12px;color:#1f7a4a}.pmr .msg.err{color:#b4232c}",
  ".pmr table{border-collapse:collapse;font-size:12px;width:100%}.pmr td,.pmr th{padding:3px 6px;border-bottom:1px solid #eef1f3;text-align:left}",
  ".pmr th{color:#5a6b75;font-weight:500}.pmr td.n{font-family:ui-monospace,Menlo,Consolas,monospace}",
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
  var leadRows = (d.leads || []).map(function (l) {
    return "<tr><td>" + l.chamber + '</td><td class="n">' + (l.amplitude_mv != null ? (l.amplitude_op || "") + l.amplitude_mv + " mV" : "—") +
      '</td><td class="n">' + (l.impedance_ohm != null ? l.impedance_ohm + " Ω" : "—") + (l.previous_impedance_ohm ? " (" + l.previous_impedance_ohm + ")" : "") +
      '</td><td class="n">' + (l.threshold_v != null ? l.threshold_v + " V @ " + l.threshold_pw_ms + " ms" : "—") + "</td></tr>";
  }).join("");
  host.innerHTML = '<style>' + CSS + '</style><div class="pmr"><div class="card">' +
    '<div class="top"><div><div class="dev">' + esc(d.device.model || "Unknown device") + (d.device.mode ? " · " + esc(d.device.mode) : "") + '</div>' +
    '<div class="sub">' + esc([d.patient.name, d.device.serial ? "SN " + d.device.serial : "", d.measured ? "Daily " + d.measured : "", d.tags.length ? "Tags: " + d.tags.join(" ") : ""].filter(Boolean).join(" · ")) + '</div></div>' +
    (opt.onClose ? '<button class="x" data-a="close" aria-label="Close">×</button>' : "") + '</div>' +
    '<div class="verdict ' + vcls + '">' + esc(vtxt) + '</div>' +
    (flags.length ? "<ul>" + flags.map(function (f) {
      return '<li><span class="pill ' + f.level + '">' + (f.level === "critical" ? "Critical" : f.level === "warn" ? "Review" : "Note") + '</span><span>' + esc(f.title) + '<span class="rule">' + esc(f.rule) + "</span></span></li>";
    }).join("") + "</ul>" : "") +
    '<div class="text-block" contenteditable="true" spellcheck="false">' + REMOTE() + '</div>' +
    '<div class="btns"><button class="b p" data-a="copy">Copy report</button>' +
    (d.patient.name ? '<button class="b" data-a="name">Copy name</button>' : "") +
    (d.device.serial ? '<button class="b" data-a="serial">Copy serial</button>' : "") +
    '<span class="msg" data-k="msg"></span></div>' +
    (leadRows ? '<table><tr><th>Lead</th><th>Sensing</th><th>Impedance (in-office)</th><th>Threshold</th></tr>' + leadRows + "</table>" : "") +
    '<div class="sub">Pacing A ' + (d.pacing_percent.atrial != null ? d.pacing_percent.atrial + "%" : "—") + " · V " + (d.pacing_percent.ventricular != null ? d.pacing_percent.ventricular + "%" : "—") +
    (d.since_reset ? " · counters since " + esc(d.since_reset) : "") + "</div>" +
    "</div></div>";

  var q = function (k) { return host.querySelector('[data-k="' + k + '"]'); };
  var setSel = function (k, val) { var s = q(k); for (var i = 0; i < s.options.length; i++) if (s.options[i].value === val) { s.selectedIndex = i; s.classList.add("prefilled"); return; } };
  var setVal = function (k, val) { if (val == null || val === "") return; var e = q(k); e.value = String(val); e.setAttribute("value", String(val)); e.classList.add("prefilled"); };

  // Fill the template
  q("site").value = d.site || T.site || SITES[0];
  if (d.site) q("site").classList.add("prefilled");
  if (d.recognised) {
    setSel("reason", REASON_OPT[d.reason] || "scheduled transmission.");
    var map = { VT: "VHR", VF: "VHR", NSVT: "NS-VT", SVT: "SVT", AHR: "AHR" };
    var counts = {};
    d.episodes.forEach(function (e) { if (map[e.type]) counts[map[e.type]] = (counts[map[e.type]] || 0) + e.count; });
    var pick = ["VHR", "NS-VT", "SVT", "AHR"].filter(function (k) { return counts[k]; })[0];
    if (pick) { setSel("episodes", "episodes of " + pick + " noted, "); setVal("epcount", counts[pick]); }
    if (d.atrial_burden_percent != null) setVal("burden", d.atrial_burden_percent);
    if (d.battery.years != null) setVal("batt", d.battery.years);
    var line = function (tag) { return flags.filter(function (f) { return f.tag === tag && f.level !== "info"; }).map(function (f) { return f.title; }).join("; "); };
    var imp = line("imp"), sen = line("sense");
    if (imp) { q("imp").textContent = "Lead impedance: " + imp; q("imp").classList.add("flagged"); }
    if (sen) { q("sense").textContent = "Sensing/capture: " + sen; q("sense").classList.add("flagged"); }
    var extra = [];
    ["VHR", "NS-VT", "SVT", "AHR"].forEach(function (k) { if (counts[k] && k !== pick) extra.push(counts[k] + " " + k + " episode" + (counts[k] > 1 ? "s" : "")); });
    d.episodes.forEach(function (e) { if (e.type === "AF48") extra.push(e.count + " atrial episode" + (e.count > 1 ? "s" : "") + " > 48 h"); });
    if (d.therapies_delivered) extra.push(d.therapies_delivered + " therapies delivered");
    var notes = d.device_notes.slice();
    q("comment").textContent = (extra.length ? "Also noted: " + extra.join(", ") + ". " : "") + notes.join(" ");
  }
  var act = q("action");
  var needs = flags.some(function (f) { return f.level !== "info"; });
  act.selectedIndex = d.recognised && !needs ? 1 : 0;
  var syncUi = function () {
    var none = q("episodes").value === "No high rate episodes were noted.";
    q("epcount-wrap").hidden = none; q("epdetail-wrap").hidden = none;
    q("comment-wrap").hidden = !q("comment").textContent.trim();
    act.classList.toggle("needs", act.value === "");
  };
  syncUi();
  host.querySelector(".text-block").addEventListener("change", syncUi);
  host.querySelector(".text-block").addEventListener("input", function () { q("comment-wrap").hidden = false; });

  var msg = function (t, err) { var m = q("msg"); m.textContent = t; m.className = "msg" + (err ? " err" : ""); };
  host.querySelector(".pmr").addEventListener("click", function (e) {
    var a = e.target.getAttribute && e.target.getAttribute("data-a");
    if (!a) return;
    if (a === "close") return opt.onClose();
    if (a === "copy") {
      if (act.value === "") { msg("Choose the action line first.", true); act.focus(); return; }
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
  box.style.cssText = "position:fixed;top:12px;right:12px;width:min(460px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;z-index:2147483647;box-shadow:0 8px 30px rgba(0,0,0,.25);border-radius:8px";
  document.body.appendChild(box);
  var host = box.attachShadow ? box.attachShadow({ mode: "open" }) : box;
  render(host, d, T, { onClose: function () { box.remove(); } });
}

var api = { SITES: SITES, DEFAULTS: DEFAULTS, THR_LABELS: THR_LABELS, lines: lines, parseLatitude: parseLatitude, evaluate: evaluate, render: render, reportText: reportText, openOverlay: openOverlay };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PMRemote = api;
})(typeof window !== "undefined" ? window : this);
