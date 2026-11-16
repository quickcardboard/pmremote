# PM Remote

Reads Boston Scientific LATITUDE (Summary page) and Medtronic CareLink (pacemaker/ICD Quick Look II, Reveal LINQ
Quick Look) remote transmissions, flags values outside the clinic's thresholds and fills the report template, ready to paste into Paceart. Everything runs in the browser:
no server, no upload, no AI.

## Use

- **Bookmarklet** (main route): open `index.html` (GitHub Pages), drag the **PM Remote** button to the
  bookmarks bar, then click it on a patient's LATITUDE Summary page. A panel opens over the page with the
  flags, the filled template, and buttons to copy the report, the patient name or the device serial.
- **Paste**: on the Summary page press Ctrl+A, Ctrl+C and paste into the page's box.

Thresholds and the default appointment site are set on the page and built into the bookmarklet
(drag it again after changing them).

## What is read (LATITUDE Summary)

Patient name, device model and serial, search tags (clinic from the tag: LMH, JPOCSC, SMH, ERH, DH, PAH, RMH, ARH; flagged when none; ADVISORY noted), My Alerts
(sets the transmission reason), per-chamber intrinsic amplitude, pace impedance (latest and in-office), pace
threshold, battery time to explant, AT/AF %, AT/AF events, VT/SVT/NSVT/atrial > 48 h counts, percent paced,
mode, and device messages such as "disabled by the Signal Artifact Monitor".

## Alerts (defaults; numbers editable on the page)

| Alert | Level |
| --- | --- |
| Pacing lead impedance < 200 or > 1000 Ω | Critical |
| Impedance change > 20% (up or down) since last check (in-office) | Review |
| Capture threshold > 1.5 V, unless within 0.25 V of last check | Review |
| P wave < 1.0 mV, ignored in DDIR or with AT/AF burden > 50% | Review |
| R wave < 5 mV | Review |
| Shock lead impedance < 20 or > 150 Ω | Critical |
| Battery ≤ 1 year / at replacement indicator / not found | Review / Critical / Note |
| AT/AF burden > 20% | Review |
| Device messages (disabled, suspended, safety mode, failed, exceeded, reverted; not MV sensor) | Review |
| No clinic in search tags | Review |

Episode counts are not alerts. The high-rate section has one line each for VHR (VT + VF + nonsustained V), SVT,
AHR (with the longest episode) and therapies; atrial episodes > 48 h are not reported. A LATITUDE "My Alerts" entry becomes the reason for transmission;
with no alert the reason is a drop-down (scheduled / patient initiation / first transmission).

The report is plain editable text; the action line is a drop-down (default "No actions taken").
Each arrhythmia type gets its own line with its count and a details box for the EGM read. AHR shows the
count and the longest episode (AT/AF Overview "Longest" duration, or the total time when there was a single
event), rounded to the nearest hour, minute or second; otherwise a box is left to fill in. Flagged
impedance or sensing replaces the fixed "Lead impedance stable" / "Sensing and capture within range" line.
MV sensor (SAM) messages are ignored.

## Medtronic CareLink

- Pacemakers and ICDs: same template and alerts as LATITUDE, fixed limits only (CareLink shows no in-office values).
  VHR = VT (>4 beats), VT-NS, High Rate-NS; SVT = SVT and Fast A&V; AHR = AT/AF; burden from the bracketed %.
  ICDs add "No therapies delivered" / "Therapy delivered: [box]" (critical alert), "Lead and HV impedance stable",
  HV 20–150 Ω, and oversensing alerts. Clinic is a drop-down starting on JPOCSC.
- Longest VHR, SVT (with V rate over 100) and AT/AF episodes come from the Episodes tab, read in the background;
  if that fails, press PM Remote on the Episodes tab and it is saved for that transmission.
- Reveal LINQ: loop template (reason, events with the longest of each type, burden, R wave, battery, Meditech date,
  action); no alerts.
- LATITUDE Events tab: longest V-# event minus 10 s, with its onset rate, read the same way.
- The panel closes itself when another patient or transmission appears.

## Develop

- `src/core.js`: parser, rules, template, panel (also loads in Node).
- `src/page.html`: the web page; `node tools/build.js` builds `index.html` and embeds the bookmarklet.
- `node test/parse.test.js`: parser and rule checks on the fictional pages in `test/fixtures/`.
  Never commit real patient pages or screenshots.

This is a drafting aid. Every report is read and signed by a clinician.
