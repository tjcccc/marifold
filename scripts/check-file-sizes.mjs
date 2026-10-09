#!/usr/bin/env node
// File-size ratchet: new files stay under the limit; recorded oversized files may shrink but not grow.
// Same behavior and baseline format as check_file_sizes.py. Run from anywhere inside the repository:
//   check-file-sizes.mjs --init    record current oversized files in .file-size-baseline.json
//   check-file-sizes.mjs           fail on a new oversized file or a recorded file that grew
//   check-file-sizes.mjs --update  lower recorded sizes after a split; never raises or adds entries
// Exclude patterns support `*` (any characters, including `/`) and `?`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const BASELINE = ".file-size-baseline.json";
const DEFAULTS = {
  limit: 800,
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".cs", ".swift", ".kt", ".java", ".vue", ".svelte", ".css", ".scss"],
  exclude: ["dist/*", "*/dist/*", "build/*", "*/build/*", "vendor/*", "*/vendor/*", "*.min.*", "*.generated.*", "*/__generated__/*", "*.test.*", "*.spec.*", "test_*.py", "*/tests/*", "tests/*", "*/__tests__/*", "*/fixtures/*"],
  files: {},
};

function globToRegExp(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "s");
}

function countLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function measure(root, config) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root });
  const excludes = config.exclude.map(globToRegExp);
  const sizes = {};
  for (const path of out.toString("utf8").split("\0").filter(Boolean)) {
    const full = join(root, path);
    if (!config.extensions.includes(extname(path)) || !existsSync(full) || !statSync(full).isFile()) {
      continue;
    }
    if (excludes.some((pattern) => pattern.test(path))) {
      continue;
    }
    sizes[path] = countLines(readFileSync(full, "utf8"));
  }
  return sizes;
}

function save(path, config) {
  config.files = Object.fromEntries(Object.entries(config.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

function main(argv) {
  const init = argv.includes("--init");
  const update = argv.includes("--update");
  if (init && update) {
    console.error("Use either --init or --update.");
    return 1;
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  const path = join(root, BASELINE);
  if (init) {
    if (existsSync(path)) {
      console.error(`${BASELINE} already exists; use --update to lower recorded sizes.`);
      return 1;
    }
    const config = structuredClone(DEFAULTS);
    config.files = Object.fromEntries(Object.entries(measure(root, config)).filter(([, lines]) => lines > config.limit));
    save(path, config);
    console.log(`Recorded ${Object.keys(config.files).length} oversized files in ${BASELINE}.`);
    return 0;
  }
  if (!existsSync(path)) {
    console.error(`${BASELINE} not found; run with --init first.`);
    return 1;
  }
  const config = { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
  const { limit, files: recorded } = config;
  const sizes = measure(root, config);
  const failures = [];
  for (const file of Object.keys(sizes).sort()) {
    const lines = sizes[file];
    if (file in recorded && lines > recorded[file]) {
      failures.push(`${file}: grew from ${recorded[file]} to ${lines} lines; split it or keep it at or below ${recorded[file]}`);
    } else if (!(file in recorded) && lines > limit) {
      failures.push(`${file}: ${lines} lines exceeds the ${limit}-line limit`);
    }
  }
  if (update) {
    config.files = Object.fromEntries(
      Object.entries(recorded)
        .filter(([file]) => file in sizes && sizes[file] > limit)
        .map(([file, lines]) => [file, Math.min(lines, sizes[file])]),
    );
    save(path, config);
  }
  for (const failure of failures) {
    console.error(failure);
  }
  return failures.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
