// node tools/build.js — assembles index.html from src/page.html + src/core.js + the example page.
const fs = require("fs"), path = require("path");
const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const core = R("src/core.js");
// Compact copy for the bookmarklet: drop comment-only lines and indentation.
const compact = core.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//") && !/^\/\*.*\*\/$/.test(l)).join("\n");
const json = (s) => JSON.stringify(s).replace(/<\//g, "<\\/");
const html = R("src/page.html")
  .replace("/*CORE*/", () => core.replace(/<\//g, "<\\/"))
  .replace('/*CORE_JSON*/""', () => json(compact))
  .replace('/*EXAMPLE_JSON*/""', () => json(R("test/fixtures/alpha.txt")));
fs.writeFileSync(path.join(__dirname, "..", "index.html"), html);
console.log("index.html", html.length, "bytes; bookmarklet ~", encodeURIComponent(compact).length, "chars");
