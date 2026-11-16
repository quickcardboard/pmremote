# PM Remote

Reads a pacemaker or implantable loop recorder remote transmission (screenshot, PDF or pasted text),
flags out-of-range values, and fills the clinic's report template ready to paste into Paceart.

## How it works

1. **Input**: drop screenshots or a PDF (first 4 pages are rendered), paste a screenshot, or paste text.
   Drag across an image to black out patient identifiers; only the blacked-out image is sent.
2. **Extraction**: Claude reads the transmission and returns structured JSON (battery, leads, pacing %,
   atrial burden, episodes, device alerts) with a note of where each value was read from.
3. **Flags**: fixed rules in the page compare the values with editable thresholds (saved per browser).
   Flags never come from the model's judgement.
4. **Report**: the values fill the author's templates (pacemaker remote, loop recorder). Flagged lead lines
   replace "Lead impedance stable" / "Sensing and capture within range"; the action line must be chosen
   by hand when anything is flagged. "Copy report" copies the plain text.

## Files

- `src/app.html`: the app (published as a claude.ai Artifact, which supplies the Claude call through
  the `sample` capability).
- `index.html`: the same page in a standalone HTML shell. Outside claude.ai it shows the example and
  the template but cannot read transmissions yet (it needs an API backend).

## Default thresholds

| Rule | Default |
| --- | --- |
| Pacing lead impedance | < 200 or > 2000 Ω (critical) |
| Impedance change vs previous | > 30% |
| P wave | < 1.5 mV |
| R wave | < 5 mV |
| Capture threshold | > 2.5 V, or output < 2× threshold |
| Ventricular pacing | > 40% |
| Atrial burden | ≥ 1% |
| Battery | ≤ 1 year, or ERI/RRT/EOS (critical) |
| Episodes | VT/VF/pause/therapy critical; NSVT, VHR, AHR, SVT, AF, brady, symptom review |

This is a drafting aid. Every report is read and signed by a clinician.
