import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(projectRoot, "site");
const outputDir = join(projectRoot, "_site");

await rm(outputDir, { force: true, recursive: true });
await mkdir(join(outputDir, "assets"), { recursive: true });
await cp(sourceDir, outputDir, { recursive: true });
await cp(join(projectRoot, "build", "icon.png"), join(outputDir, "assets", "icon.png"));

const files = await readdir(outputDir, { recursive: true });
console.log(`GitHub Pages site built with ${files.length} files in ${outputDir}`);
