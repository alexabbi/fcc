// Bundles the CLI into dist/ so the plugin runs on any Node >= 18 with no
// npm install: hooks execute with the *project's* Node, which may be too old
// to run TypeScript natively.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: { fcc: "bin/fcc.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  // Hooks stay small: ts-morph/TypeScript load only in the `analyze` chunk.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  minify: true,
  legalComments: "none",
  // TypeScript (inside ts-morph) is CommonJS and calls require() on Node builtins.
  banner: {
    js: [
      'import { createRequire as __fccCreateRequire } from "node:module";',
      'import { fileURLToPath as __fccFileURLToPath } from "node:url";',
      "const require = __fccCreateRequire(import.meta.url);",
      "const __filename = __fccFileURLToPath(import.meta.url);",
      'const __dirname = __fccFileURLToPath(new URL(".", import.meta.url));',
    ].join("\n"),
  },
  logLevel: "warning",
});

const web = new URL("web/", dist);
mkdirSync(new URL("vendor/", web), { recursive: true });
for (const f of ["index.html", "app.js", "story.js", "app.css"]) cpSync(new URL(`../src/web/${f}`, import.meta.url), new URL(f, web));
const vendor = {
  "cytoscape.js": "cytoscape/dist/cytoscape.min.js",
  "elk.js": "elkjs/lib/elk.bundled.js",
  "cytoscape-elk.js": "cytoscape-elk/dist/cytoscape-elk.js",
};
for (const [name, src] of Object.entries(vendor)) {
  cpSync(new URL(`../node_modules/${src}`, import.meta.url), new URL(`vendor/${name}`, web));
}
console.log("built dist/fcc.mjs and dist/web/");
