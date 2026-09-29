#!/usr/bin/env node
'use strict';

/**
 * `npm run example [name…]`
 *
 * DOC-002. The examples exist so a reader can see a working call before
 * reading the guide, and an example nobody runs is an example that rots: the
 * API moves, the script keeps its old argument order, and nothing notices until
 * a reader copies it and it fails.
 *
 * So they are executed. `test/examples.test.js` runs every one on every
 * `npm test`, and this script is the interactive entry point:
 *
 *   npm run example              list them
 *   npm run example cache        run one
 *   npm run example cache codec  run several
 *   npm run example -- --all     run all
 *
 * Resolution is deliberately narrow. A name that is not a file in `examples/`
 * is an error rather than a suggestion, because the alternative — running
 * something the caller did not name — is the kind of helpfulness that
 * surprises people.
 */

import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = join(root, 'examples');

/** Every example, by name (the filename without its extension). */
function available() {
  if (!existsSync(examplesDir)) return [];
  return readdirSync(examplesDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -4))
    .sort();
}

/** Run one example, resolving only if it exits non-zero. */
function run(name) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(examplesDir, `${name}.mjs`)], {
      stdio: 'inherit',
      cwd: root,
    });
    child.on('close', (code) => resolveRun({ name, code: code ?? 1 }));
    child.on('error', () => resolveRun({ name, code: 1 }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const names = args.filter((a) => !a.startsWith('--'));
  const examples = available();

  if (examples.length === 0) {
    console.error('No examples found in examples/.');
    return 1;
  }

  if (names.length === 0 && !all) {
    console.log('Available examples:\n');
    for (const name of examples) console.log(`  ${name}`);
    console.log('\nRun one:  npm run example <name>');
    console.log('Run all:  npm run example -- --all');
    return 0;
  }

  const requested = all ? examples : names;
  const unknown = requested.filter((n) => !examples.includes(n));
  if (unknown.length) {
    // A near-miss is usually a typo, and running the wrong script would look
    // like it worked.
    for (const bad of unknown) {
      const near = examples.find((n) => n.startsWith(bad.slice(0, 3)));
      console.error(`Unknown example: ${bad}` + (near ? ` — did you mean "${near}"?` : ''));
    }
    return 1;
  }

  const failures = [];
  for (const name of requested) {
    if (requested.length > 1) console.log(`\n${'='.repeat(60)}\n${name}\n${'='.repeat(60)}`);
    const { code } = await run(name);
    if (code !== 0) failures.push(name);
  }

  if (failures.length) {
    console.error(`\n${failures.length} example(s) failed: ${failures.join(', ')}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  }
);
