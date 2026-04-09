#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const srcHelpers = path.join(root, 'src');

function listJsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      out.push(...listJsFiles(p));
    } else if (st.isFile() && p.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

function listAllJsFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'coverage' || name === '.git') continue;
      out.push(...listAllJsFiles(p));
    } else if (st.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

function extractExports(content) {
  const symbols = [];
  const classRx = /export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const fnRx = /export\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const varRx = /export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const defaultRx = /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  const namedRx = /export\s*\{([^}]+)\}/g;

  let m;
  while ((m = classRx.exec(content))) symbols.push(m[1]);
  while ((m = fnRx.exec(content))) symbols.push(m[1]);
  while ((m = varRx.exec(content))) symbols.push(m[1]);
  while ((m = defaultRx.exec(content))) symbols.push(m[1]);
  while ((m = namedRx.exec(content))) {
    const list = m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const s of list) symbols.push(s);
  }
  return Array.from(new Set(symbols));
}

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}

const helperFiles = listJsFiles(srcHelpers);
const allJsFiles = listAllJsFiles(root);

const report = [];
const symbolMap = {};

for (const file of helperFiles) {
  const content = readFileSafe(file);
  if (!content) continue;
  const exports = extractExports(content);
  for (const sym of exports) {
    if (!symbolMap[sym]) symbolMap[sym] = { def: file, refs: new Set() };
    else symbolMap[sym].def = symbolMap[sym].def || file;
  }
}

for (const [sym, info] of Object.entries(symbolMap)) {
  const rx = new RegExp('\\b' + sym + '\\b', 'g');
  for (const file of allJsFiles) {
    const c = readFileSafe(file);
    if (!c) continue;
    if (file === info.def) continue; // skip declaration file
    if (rx.test(c)) info.refs.add(file);
  }
}

for (const [sym, info] of Object.entries(symbolMap)) {
  report.push({ symbol: sym, definedIn: path.relative(root, info.def), referencedIn: Array.from(info.refs).map(f => path.relative(root, f)) });
}

const out = { generatedAt: new Date().toISOString(), report };
fs.writeFileSync(path.join('scripts','static-audit-exports.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
