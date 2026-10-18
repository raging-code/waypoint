#!/usr/bin/env node
/**
 * Waypoint tile fix: removes the CARTO map styles that now show "API KEY REQUIRED".
 *
 * Use this if you already ran the first patch-maps.mjs. It:
 *   - removes the "Light" and "Dark" styles (both came from CARTO)
 *   - makes "Streets" (OpenStreetMap) the default
 *   - keeps Streets, Satellite (Esri) and Terrain (OpenTopoMap), all free without a key
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *
 *   node fix-tiles.mjs            apply the fix
 *   node fix-tiles.mjs --revert   undo it
 *   node fix-tiles.mjs <folder>   fix a project in another folder
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const folderArg = args.find((a) => !a.startsWith("-"));
const root = resolve(folderArg ?? dirname(fileURLToPath(import.meta.url)));

const FILES = {
  js: join(root, "app", "static", "js", "app.js"),
  html: join(root, "app", "templates", "index.html"),
};
const BACKUP = ".bak-tilefix";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const path of Object.values(FILES)) {
  if (!existsSync(path)) {
    fail(`Cannot find ${path}\nRun this script from the Waypoint folder (the one containing run.py), or pass the folder: node fix-tiles.mjs <folder>`);
  }
}

if (revert) {
  let restored = 0;
  for (const path of Object.values(FILES)) {
    if (existsSync(path + BACKUP)) {
      copyFileSync(path + BACKUP, path);
      restored++;
    }
  }
  console.log(restored ? `Reverted ${restored} file(s).` : "No backups found, nothing to revert.");
  process.exit(0);
}

const jsRaw = readFileSync(FILES.js, "utf8");
if (!jsRaw.includes("cartocdn.com")) {
  if (jsRaw.includes("patch: map-styles")) {
    console.log("Already fixed: no CARTO tiles in the project. Nothing to do.");
  } else {
    console.log("This project has no CARTO tiles left in the style list and was not patched. Nothing to do.");
  }
  process.exit(0);
}
if (!jsRaw.includes("patch: map-styles")) {
  fail("This project has the original map code, not the first patch.\nRun the updated patch-maps.mjs instead: node patch-maps.mjs");
}

const EDITS = [
  {
    file: "js",
    why: "remove the CARTO Light style",
    find: `    {
      id: "light", name: "Light",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: OSM_CREDIT + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    },
`,
    replace: ``,
  },
  {
    file: "js",
    why: "remove the CARTO Dark style",
    find: `    {
      id: "dark", name: "Dark",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: OSM_CREDIT + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    },
`,
    replace: ``,
  },
  {
    file: "js",
    why: "make Streets (OpenStreetMap) the default style",
    find: `loadPref("mapStyle", "light")`,
    replace: `loadPref("mapStyle", "streets")`,
  },
  {
    file: "html",
    why: "show Streets as the first chip label",
    find: `aria-label="Change map style">Light</button>`,
    replace: `aria-label="Change map style">Streets</button>`,
  },
];

const texts = { js: jsRaw, html: readFileSync(FILES.html, "utf8") };
const crlf = Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, v.includes("\r\n")]));
for (const k of Object.keys(texts)) texts[k] = texts[k].replace(/\r\n/g, "\n");

for (const edit of EDITS) {
  const count = texts[edit.file].split(edit.find).length - 1;
  if (count !== 1) {
    fail(
      `Could not apply: "${edit.why}" (${FILES[edit.file]}).\n` +
        `Expected to find the original text exactly once but found it ${count} times.\n` +
        `Your files may have been edited. Nothing was changed.`
    );
  }
  texts[edit.file] = texts[edit.file].replace(edit.find, () => edit.replace);
}

if (texts.js.includes("cartocdn.com")) {
  fail("Unexpected result: CARTO is still referenced. Nothing was changed.");
}

for (const [key, path] of Object.entries(FILES)) {
  if (!existsSync(path + BACKUP)) copyFileSync(path, path + BACKUP);
  const out = crlf[key] ? texts[key].replace(/\n/g, "\r\n") : texts[key];
  writeFileSync(path, out, "utf8");
}

console.log("Fixed: CARTO styles removed. Styles now: Streets (default), Satellite, Terrain.");
console.log("Restart the app, then hard-refresh the page (Ctrl+F5).");
console.log("Undo with: node fix-tiles.mjs --revert");
