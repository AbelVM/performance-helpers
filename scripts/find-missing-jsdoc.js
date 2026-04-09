#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && full.endsWith('.js')) files.push(full);
  }
  return files;
}

function isReexport(line) {
  return /\bfrom\b/.test(line) || /^\s*export\s*{/.test(line);
}

function isExportDecl(line) {
  // matches export default class/function, export class, export function, export const/let/var
  return (
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:class|function)\b/.test(line) ||
    /^\s*export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*/.test(line) ||
    /^\s*export\s+default\s*(?:\(|[A-Za-z_$])/.test(line)
  );
}

function hasJSDocBefore(lines, idx) {
  let j = idx - 1;
  while (j >= 0) {
    const t = lines[j].trim();
    if (t === '') {
      j--;
      continue;
    }
    return t.startsWith('/**');
  }
  return false;
}

const root = path.join(__dirname, '..', 'src');
const files = walk(root);
const findings = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\bexport\b/.test(line)) continue;
    if (isReexport(line)) continue;
    if (!isExportDecl(line)) continue;
    if (!hasJSDocBefore(lines, i)) {
      findings.push({ file: path.relative(process.cwd(), file), line: i + 1, code: line.trim() });
    }
  }
}

console.log(JSON.stringify(findings, null, 2));
if (findings.length === 0) process.exit(0);
process.exit(1);
