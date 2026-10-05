#!/usr/bin/env node
/**
 * Strip `_`-prefixed private-member declarations from generated `.d.ts` files.
 *
 * This runs after `tsc --emitDeclarationOnly` so the published type surface only
 * exposes intentionally public members. `_metrics` is preserved because it is
 * deliberately emitted as a plain object type (see `src/helpers/metrics.js`).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const typesDir = path.join(root, 'types', 'helpers');

// _metrics is intentionally public: a plain object type so it does not require
// an import of MetricsCollector in nine `.d.ts` files.
const EXCLUDED = new Set(['_metrics']);

function isPrivateMemberLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // `private _foo(...)` or `private _foo;`
  if (/^\s*private\s+_[\w$]+/.test(line)) return true;

  // `_foo: type;` or `_foo: {`
  if (/^\s+_[\w$]+[:\s]/.test(line)) return true;

  return false;
}

function memberName(line) {
  const m = line.match(/^\s*(?:private\s+)?(_[\w$]+)/);
  return m ? m[1] : null;
}

function stripPrivateMembers(content) {
  const lines = content.split('\n');
  const out = [];
  let inBlock = null; // { indent } when stripping a multi-line `_name: { ... }` block

  for (const line of lines) {
    if (inBlock) {
      const lineIndent = line.match(/^\s*/)[0].length;
      const startsClosingBrace = line.trimStart().startsWith('}');
      // Continue stripping while indented deeper than the block start, or while
      // consuming the closing brace line itself.
      if (lineIndent > inBlock.indent || (lineIndent === inBlock.indent && startsClosingBrace)) {
        continue;
      }
      inBlock = null;
    }

    if (isPrivateMemberLine(line)) {
      const name = memberName(line);
      if (name && EXCLUDED.has(name)) {
        out.push(line);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.endsWith('{')) {
        inBlock = { indent: line.match(/^\s*/)[0].length };
      }
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function processFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const stripped = stripPrivateMembers(content);
  if (stripped !== content) {
    fs.writeFileSync(filePath, stripped, 'utf8');
    console.log(`Stripped: ${path.relative(root, filePath)}`);
  }
}

function main() {
  const entries = fs.readdirSync(typesDir);
  for (const entry of entries) {
    if (!entry.endsWith('.d.ts')) continue;
    processFile(path.join(typesDir, entry));
  }
}

main();
