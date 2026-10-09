#!/usr/bin/env node
// Markdown prose is not hard-wrapped (owner's harness rule). Finds lines that
// continue a paragraph, list item, or blockquote from the previous source line.
//   node scripts/markdown-wrap.mjs         report them and exit 1
//   node scripts/markdown-wrap.mjs --fix   join them into the line they continue
// Code fences, indented code, tables, headings, HTML, thematic breaks, and
// explicit hard breaks (two trailing spaces, a trailing backslash, <br>) are kept.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Tool-generated projnavi notes and example Skill prompt files are not prose docs.
const EXCLUDE = [/^\.projnavi\//, /^examples\//];
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const THEMATIC_BREAK = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/** Zero-based indexes of lines that continue the previous source line. */
export function continuationLines(lines) {
  const result = [];
  let inFence = false;
  let prevText = false;
  let inList = false;
  let prevBlank = true;
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    start = end > 0 ? end + 1 : 0;
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = line.trim();
    if (FENCE.test(line)) {
      inFence = !inFence;
      prevText = false;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!stripped) {
      prevText = false;
      prevBlank = true;
      continue;
    }
    const indented = line.length - line.trimStart().length >= 4 || line.startsWith('\t');
    if (LIST_ITEM.test(line)) {
      inList = true;
      prevText = true;
    } else if (/^[#|<]/.test(stripped) || THEMATIC_BREAK.test(line)) {
      inList = false;
      prevText = false;
    } else if (indented && prevBlank && !inList) {
      prevText = false;
    } else {
      if (prevText) {
        result.push(index);
      }
      if (!indented && prevBlank) {
        inList = false;
      }
      prevText = !(line.endsWith('  ') || line.endsWith('\\') || stripped.endsWith('<br>'));
    }
    prevBlank = false;
  }
  return result;
}

/** Join every continuation line into the line it continues. */
export function unwrap(text) {
  const lines = text.split('\n');
  const joined = new Set(continuationLines(lines));
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!joined.has(index)) {
      out.push(lines[index]);
      continue;
    }
    const previous = out.pop();
    let piece = lines[index].trim();
    // A quoted continuation drops its quote marker when joined to a quoted line.
    if (previous.trimStart().startsWith('>')) {
      piece = piece.replace(/^>\s?/, '');
    }
    out.push(`${previous.trimEnd()} ${piece}`);
  }
  return out.join('\n');
}

function markdownFiles(root) {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '*.md'], { cwd: root });
  return out.toString('utf8').split('\0').filter((path) => path && !EXCLUDE.some((pattern) => pattern.test(path)));
}

function main(argv) {
  const fix = argv.includes('--fix');
  const root = execFileSync('git', ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  let total = 0;
  for (const path of markdownFiles(root)) {
    const full = join(root, path);
    const text = readFileSync(full, 'utf8');
    const lines = continuationLines(text.split('\n'));
    if (lines.length === 0) {
      continue;
    }
    total += lines.length;
    if (fix) {
      writeFileSync(full, unwrap(text));
      console.log(`${path}: joined ${lines.length} wrapped lines`);
    } else {
      console.error(`${path}:${lines[0] + 1}: ${lines.length} hard-wrapped lines (fix with node scripts/markdown-wrap.mjs --fix)`);
    }
  }
  return fix || total === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
