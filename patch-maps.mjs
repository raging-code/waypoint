#!/usr/bin/env node
/**
 * Waypoint map patch: free map styles, no API key, no billing account.
 *
 * Adds five free map styles to the dashboard and makes the chip at the top-left of
 * the map clickable to switch between them (the choice is remembered):
 *
 *   Light      CARTO Positron      (OpenStreetMap data)
 *   Streets    OpenStreetMap standard
 *   Satellite  Esri World Imagery
 *   Terrain    OpenTopoMap
 *   Dark       CARTO Dark Matter
 *
 * Usage (run from the Waypoint project folder, the one that contains run.py):
 *
 *   node patch-maps.mjs            apply the patch
 *   node patch-maps.mjs --revert   undo it (restores the .bak-mapstyles backups)
 *   node patch-maps.mjs <folder>   patch a project in another folder
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 * Tiles still need an internet connection; keep GOOGLE_MAPS_API_KEY blank in .env.
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
  css: join(root, "app", "static", "css", "style.css"),
};
const BACKUP = ".bak-mapstyles";
const MARKER = "/* patch: map-styles */";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const [name, path] of Object.entries(FILES)) {
  if (!existsSync(path)) {
    fail(`Cannot find ${path}\nRun this script from the Waypoint folder (the one containing run.py), or pass the folder: node patch-maps.mjs <folder>`);
  }
}

// ---------------------------------------------------------------- revert
if (revert) {
  let restored = 0;
  for (const path of Object.values(FILES)) {
    if (existsSync(path + BACKUP)) {
      copyFileSync(path + BACKUP, path);
      restored++;
    }
  }
  console.log(restored ? `Reverted ${restored} file(s) from their ${BACKUP} backups.` : "No backups found, nothing to revert.");
  process.exit(0);
}

// ---------------------------------------------------------------- already patched?
const jsText = readFileSync(FILES.js, "utf8");
if (jsText.includes(MARKER)) {
  console.log("Already patched. Nothing to do. (Use --revert to undo.)");
  process.exit(0);
}

// ---------------------------------------------------------------- new code
const TILE_STYLES = `${MARKER}
  // Free map styles. No API key needed. Keep the attribution text: the licences require it.
  const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const TILE_STYLES = [
    {
      id: "light", name: "Light",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: OSM_CREDIT + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    },
    {
      id: "streets", name: "Streets",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxNativeZoom: 19, maxZoom: 20, attribution: OSM_CREDIT },
    },
    {
      id: "satellite", name: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: { maxNativeZoom: 19, maxZoom: 20, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" },
    },
    {
      id: "terrain", name: "Terrain",
      url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      options: { subdomains: "abc", maxNativeZoom: 17, maxZoom: 20, attribution: 'Map data: ' + OSM_CREDIT + ', SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
    },
    {
      id: "dark", name: "Dark",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      options: { subdomains: "abcd", maxZoom: 20, attribution: OSM_CREDIT + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' },
    },
  ];

  function createLeafletMap(el) {`;

// ---------------------------------------------------------------- edits
// Every "find" must occur exactly once in its file, otherwise nothing is written.
const EDITS = [
  {
    file: "js",
    why: "add the list of free map styles",
    find: `  function createLeafletMap(el) {`,
    replace: TILE_STYLES,
  },
  {
    file: "js",
    why: "replace the single tile layer with a switchable one",
    find: `    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(m);`,
    replace: `    let styleIdx = Math.max(0, TILE_STYLES.findIndex((s) => s.id === loadPref("mapStyle", "light")));
    let tiles = null;
    function applyStyle() {
      if (tiles) m.removeLayer(tiles);
      const st = TILE_STYLES[styleIdx];
      tiles = L.tileLayer(st.url, st.options).addTo(m);
      tiles.bringToBack();
    }
    applyStyle();`,
  },
  {
    file: "js",
    why: "show the current style name and add cycleStyle()",
    find: `      label: "OpenStreetMap",
      moveTo(lat, lon, opts) {
        const ll = [lat, lon];`,
    replace: `      get label() { return TILE_STYLES[styleIdx].name; },
      cycleStyle() {
        styleIdx = (styleIdx + 1) % TILE_STYLES.length;
        applyStyle();
        savePref("mapStyle", TILE_STYLES[styleIdx].id);
      },
      moveTo(lat, lon, opts) {
        const ll = [lat, lon];`,
  },
  {
    file: "js",
    why: "recognise the Leaflet map without relying on its old label",
    find: `if (map && map.label === "OpenStreetMap") return;`,
    replace: `if (map && map.cycleStyle) return;`,
  },
  {
    file: "js",
    why: "clicking the chip switches the map style",
    find: `    $("#btnFollow").addEventListener("click", () => setFollow(!store.follow));`,
    replace: `    $("#providerChip").addEventListener("click", () => {
      if (!map || !map.cycleStyle) return;
      map.cycleStyle();
      $("#providerChip").textContent = map.label;
    });
    $("#btnFollow").addEventListener("click", () => setFollow(!store.follow));`,
  },
  {
    file: "html",
    why: "make the map chip a real button",
    find: `<span id="providerChip" class="provider">OpenStreetMap</span>`,
    replace: `<button id="providerChip" class="provider" type="button" title="Change map style" aria-label="Change map style">Light</button>`,
  },
  {
    file: "css",
    why: "style the chip as a button",
    find: `.map-notice[hidden] { display: none; }`,
    replace: `button.provider { font: inherit; font-size: 12.5px; cursor: pointer; }
.provider:hover { background: #fff; color: var(--ink); }
.map-notice[hidden] { display: none; }`,
  },
];

// ---------------------------------------------------------------- apply (all or nothing)
const texts = {
  js: jsText,
  html: readFileSync(FILES.html, "utf8"),
  css: readFileSync(FILES.css, "utf8"),
};
// Normalise Windows line endings while matching, and put them back when writing.
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

for (const [key, path] of Object.entries(FILES)) {
  if (!existsSync(path + BACKUP)) copyFileSync(path, path + BACKUP);
  const out = crlf[key] ? texts[key].replace(/\n/g, "\r\n") : texts[key];
  writeFileSync(path, out, "utf8");
}

console.log("Patched: free map styles added (Light, Streets, Satellite, Terrain, Dark).");
console.log("Restart the app and hard-refresh the page (Ctrl+F5).");
console.log("Click the label at the top-left of the map to change the style.");
console.log("Leave GOOGLE_MAPS_API_KEY empty in .env. Undo with: node patch-maps.mjs --revert");
