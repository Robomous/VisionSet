import { readFileSync, writeFileSync } from "node:fs";

const RULES = [
  [/from "@\/lib\/cn"/g, 'from "../lib/cn"'],
  [/from "@\/primitives\/([a-z-]+)"/g, 'from "./$1"'],
];

export function relativize(source) {
  return RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source);
}

if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1].endsWith("shadcn_relativize.mjs")) {
  for (const file of process.argv.slice(2)) {
    writeFileSync(file, relativize(readFileSync(file, "utf8")));
  }
}
