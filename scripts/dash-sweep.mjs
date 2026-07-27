#!/usr/bin/env node
// Fail if any em dash (U+2014) or en dash (U+2013) is present in committed text.
// Mirrors the machine-wide writing gate. Exit 1 on any hit, 0 when clean.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", "dist", "output", ".git", "coverage"]);
const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".txt"]);
const BAD = new RegExp("[\\u2014\\u2013]");

let hits = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (EXT.has(extname(name))) {
      const text = readFileSync(full, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (BAD.test(line)) {
          hits += 1;
          console.error(`${full}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
}

walk(ROOT);
if (hits > 0) {
  console.error(`dash-sweep: ${hits} dash occurrence(s) found`);
  process.exit(1);
}
console.log("dash-sweep: clean");
