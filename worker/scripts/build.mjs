import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const publicDir = resolve(root, "worker/public");
await mkdir(publicDir, { recursive: true });
await copyFile(resolve(root, "index.html"), resolve(publicDir, "index.html"));

const config = {
  apiBaseUrl: process.env.HUSSAM_API_BASE_URL || "",
  turnstileSiteKey: process.env.HUSSAM_TURNSTILE_SITE_KEY || ""
};
const configSource = "window.HUSSAM_CONFIG = Object.freeze(" + JSON.stringify(config) + ");\n";
await writeFile(resolve(publicDir, "config.js"), configSource, "utf8");
console.log("Built HUSSAM INFOGRAPHIC frontend into worker/public");
