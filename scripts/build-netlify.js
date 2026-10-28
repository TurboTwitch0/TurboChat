"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const publish = path.join(root, "dist");
fs.rmSync(publish, { recursive: true, force: true });
fs.mkdirSync(publish, { recursive: true });
// Keep the old asset URLs valid for older pages, but new HTML always gets a
// matched content-addressed script and a single stylesheet from this build.
for (const file of ["app.js", "styles.css", "brand.css", "showcase.css"]) fs.copyFileSync(path.join(root, file), path.join(publish, file));
const manifest = {};
for (const [kind, source] of [["stylesheet", "styles.css"], ["script", "app.js"]]) {
  const contents = fs.readFileSync(path.join(root, source));
  const sha256 = crypto.createHash("sha256").update(contents).digest("hex");
  const extension = path.extname(source), file = `${path.basename(source, extension)}.${sha256.slice(0, 12)}${extension}`;
  fs.writeFileSync(path.join(publish, file), contents);
  manifest[kind] = { file, sha256 };
}
let html = fs.readFileSync(path.join(root, "index.html"), "utf8")
  .replace(/href="styles\.css(?:\?[^\"]*)?"/, `href="${manifest.stylesheet.file}"`)
  .replace(/src="app\.js(?:\?[^\"]*)?"/, `src="${manifest.script.file}"`);
if ((html.match(/rel="stylesheet"/g) || []).length !== 1 || !html.includes(manifest.stylesheet.file) || !html.includes(manifest.script.file)) throw new Error("The page must reference one matching stylesheet and script.");
fs.writeFileSync(path.join(publish, "index.html"), html);
fs.writeFileSync(path.join(publish, "asset-manifest.json"), JSON.stringify(manifest, null, 2));
fs.cpSync(path.join(root, "assets"), path.join(publish, "assets"), { recursive: true });
fs.cpSync(path.join(root, "media"), path.join(publish, "media"), { recursive: true });
console.log("Netlify static site built in dist/.");
