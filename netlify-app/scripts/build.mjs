import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const source = resolve(root, "src/startup_voice");
const out = resolve(here, "../dist");

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "static/features"), { recursive: true });
await cp(resolve(source, "static/index.html"), resolve(out, "index.html"));
await cp(resolve(source, "static"), resolve(out, "static"), { recursive: true });
for (const feature of ["dossier", "voice", "sessions", "prefs", "interview", "ido"]) {
  const from = resolve(source, "features", feature, "ui");
  try {
    await cp(from, resolve(out, "static/features", feature), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
console.log(`Copied the existing browser app into ${out}`);
