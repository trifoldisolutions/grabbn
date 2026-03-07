import chokidar from "chokidar";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Required for ES modules (__dirname equivalent)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute paths (IMPORTANT on Windows)
const SRC_DIR = path.join(__dirname, "public");
const OUT_DIR = path.join(__dirname, "txt");

console.log("👀 Watching:", SRC_DIR);

function mirror(file) {
  const relativePath = path.relative(SRC_DIR, file);
  const outFile = path.join(
    OUT_DIR,
    relativePath.replace(/\.html$/i, ".txt")
  );

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.copyFileSync(file, outFile);

  console.log(`✔ Mirrored: ${relativePath}`);
}

const watcher = chokidar.watch(SRC_DIR, {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 100
  }
});

watcher
  .on("add", file => {
    if (file.endsWith(".html")) mirror(file);
  })
  .on("change", file => {
    if (file.endsWith(".html")) mirror(file);
  })
  .on("ready", () => {
    console.log("✅ Watcher ready");
  })
  .on("error", error => {
    console.error("❌ Watcher error:", error);
  });
