import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const source = resolve(root, "src/startup_voice");
const out = resolve(here, "../dist");

/** Same format as src/startup_voice/version.py: <day>.<month>.<commit count>. */
function appVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    const date = git("log", "-1", "--format=%cd", "--date=format:%d.%m");
    // A shallow clone has a wrong count; the short commit hash is still unique.
    const shallow = git("rev-parse", "--is-shallow-repository") === "true";
    return `${date}.${shallow ? git("rev-parse", "--short", "HEAD") : git("rev-list", "--count", "HEAD")}`;
  } catch {
    return "dev";
  }
}

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "static/features"), { recursive: true });
const version = appVersion();
const html = (await readFile(resolve(source, "static/index.html"), "utf8")).replaceAll("__APP_VERSION__", version);
await writeFile(resolve(out, "index.html"), html);
await cp(resolve(source, "static"), resolve(out, "static"), { recursive: true });
for (const feature of ["dossier", "voice", "sessions", "prefs", "interview", "ido", "board"]) {
  const from = resolve(source, "features", feature, "ui");
  try {
    await cp(from, resolve(out, "static/features", feature), { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
console.log(`Copied the existing browser app into ${out} (version ${version})`);
