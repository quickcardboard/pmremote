# PM Remote

Reads a Boston Scientific LATITUDE **Summary** page, flags values outside the clinic's thresholds and fills
the remote-transmission report template, ready to paste into Paceart. Everything runs in the browser:
no server, no upload, no AI.

## Use

- **Bookmarklet** (main route): open `index.html` (GitHub Pages), drag the **PM Remote** button to the
  bookmarks bar, then click it on a patient's LATITUDE Summary page. A panel opens over the page with the
  flags, the filled template, and buttons to copy the report, the patient name or the device serial.
- **Paste**: on the Summary page press Ctrl+A, Ctrl+C and paste into the page's box.

Thresholds and the default appointment site are set on the page and built into the bookmarklet
(drag it again after changing them).

## What is read (LATITUDE Summary)

Patient name, device model and serial, search tags (appointment site from the tag; ADVISORY noted), My Alerts
(sets the transmission reason), per-chamber intrinsic amplitude, pace impedance (latest and in-office), pace
threshold, battery time to explant, AT/AF %, AT/AF events, VT/SVT/NSVT/atrial > 48 h counts, percent paced,
mode, and device messages such as "disabled by the Signal Artifact Monitor".

## Rules (defaults, editable)

| Rule | Default |
| --- | --- |
| Pacing lead impedance | < 200 or > 2000 Ω (critical) |
| Impedance change vs in-office | > 30% |
| P wave / R wave | < 1.5 mV / < 5 mV |
| Capture threshold | > 2.5 V |
| Ventricular pacing | > 40% |
| AT/AF burden | ≥ 1% |
| Battery | ≤ 1 year (critical at explant indicator) |
| Episodes | VT/VF and therapies critical; NSVT, SVT, AT/AF events, atrial > 48 h review |

Flagged impedance or sensing replaces the fixed "Lead impedance stable" / "Sensing and capture within range"
line, and the action line must be chosen by hand when anything is flagged.

## Develop

- `src/core.js`: parser, rules, template, panel (also loads in Node).
- `src/page.html`: the web page; `node tools/build.js` builds `index.html` and embeds the bookmarklet.
- `node test/parse.test.js`: parser and rule checks on the fictional pages in `test/fixtures/`.
  Never commit real patient pages or screenshots.

This is a drafting aid. Every report is read and signed by a clinician.
