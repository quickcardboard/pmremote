# PM Remote

Browser-only reader for LATITUDE remote transmissions (see README). No AI and no network calls: the user
asked for deterministic parsing only. Never commit real patient data; test fixtures are fictional.

- Edit `src/core.js` / `src/page.html`, then `node tools/build.js` and commit the rebuilt `index.html`.
- Run `node test/parse.test.js` after any parser or rule change.
- Keep the author's template wording (pacemaker remote and loop recorder) as given.
