#!/usr/bin/env node
/**
 * Mutation check for `PowerServo`.
 *
 * The release notes claim a list of mutants are all killed by the test suite.
 * That claim is otherwise not checkable: there is no harness for it anywhere in
 * the repository, so a future change to the tests could quietly stop covering
 * one and the claim would keep reading as though it had been verified. This
 * script is that verification, and it is the artefact rather than the assertion
 * that makes the assertion true.
 *
 * ### It never touches the working tree
 *
 * The obvious implementation — back the file up, mutate it in place, run the
 * tests, restore — is the move `AGENTS.md` describes as standard, and it is
 * also how a source file gets destroyed: a mutation run that overlaps an edit
 * restores the backup *over* that edit. This repository has been bitten by that
 * class of accident twice with `git stash`, and the working tree here is shared
 * with a session that is not visible to the agent manager.
 *
 * So each mutant is written into a throwaway copy of `src/` in a temp
 * directory, and vitest runs against that copy. Nothing under the repository is
 * read-modified, and there is nothing to restore if the process is killed.
 *
 * A mutant is **killed** when the suite exits non-zero. A mutant that survives
 * means the suite no longer covers the behaviour the release notes attribute to
 * it, which is a real finding and fails this script.
 *
 * Usage: `node scripts/mutant-check.mjs [--verbose] [--only <substring>]`
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const SUBJECT = 'src/helpers/powerServo.js';
const TEST = 'test/powerServo.test.js';

const verbose = process.argv.includes('--verbose');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg === -1 ? null : process.argv[onlyArg + 1];

/**
 * Each mutant is an exact `find` / `replace` pair against the real source.
 *
 * Exact strings rather than line numbers on purpose: a line-number mutant
 * silently mutates the wrong line once anything above it shifts, and then reports
 * a survivor that is really just a bad edit. Every `find` is asserted to occur
 * exactly once before the run, so a drifted source fails loudly here instead of
 * producing a meaningless table.
 */
const MUTANTS = [
  {
    name: 'derivative taken on the error, not the measurement',
    // Needs the *previous error*, not the previous measurement: on a constant
    // setpoint the two differ only by a sign, so a sign flip would not exercise
    // the behaviour at all. The setpoint-step spike only appears if the setpoint
    // is remembered across samples, so the mutant has to remember it too.
    find: 'rawDerivative = (this._previousMeasured - measured) / h;',
    replace:
      'rawDerivative = ((this._mutantPrevError ?? error) - error) / h;\n      this._mutantPrevError = error;',
  },
  {
    name: 'zero-length span divided through (the seventeenth)',
    find: 'if (this._previousMeasured !== null && h > 0) {',
    replace:
      'if (this._previousMeasured !== null) {\n        const span = h === 0 ? this._defaultDt : h;',
  },
  {
    name: 'integral clamp removed',
    find: 'if (contribution < lo) this._integral = divideOrZero(lo, this._ki);\n      else if (contribution > hi) this._integral = divideOrZero(hi, this._ki);',
    replace: '// mutant: no integral clamp',
  },
  {
    name: 'clamp window ignores the feedforward term',
    find: 'const lo = this.min - ff - this._kp * error;\n      const hi = this.max - ff - this._kp * error;',
    replace:
      'const lo = this.min - this._kp * error;\n      const hi = this.max - this._kp * error;',
  },
  {
    name: 'clamp window widened to infinity',
    find: 'const lo = this.min - ff - this._kp * error;\n      const hi = this.max - ff - this._kp * error;',
    replace: 'const lo = -Infinity;\n      const hi = Infinity;',
  },
  {
    name: 'output bounds not applied',
    find: 'const output = clamp(unclamped, this.min, this.max);',
    replace: 'const output = unclamped;',
  },
  {
    name: 'feedforward gain dropped',
    find: 'ff = this._feedforwardGain * disturbance;',
    replace: 'ff = 0;',
  },
  {
    name: 'saturated reverted to clip detection',
    find: 'this._saturated = output === this.min || output === this.max;',
    replace: 'this._saturated = unclamped !== output;',
  },
  {
    name: 'reset() keeps the integral',
    find: '  reset() {\n    this._integral = 0;',
    replace: '  reset() {\n    // mutant: integral retained',
  },
  {
    name: 'dispose() is a no-op',
    find: '  dispose() {\n    this.reset();\n  }',
    replace: '  dispose() {\n    // mutant: no teardown at all\n  }',
  },
  {
    name: 'step() ignores dt',
    find: 'const h = dt === undefined ? this._defaultDt : Math.max(0, finite(dt, 0));',
    replace: 'const h = this._defaultDt;',
  },
  {
    name: 'setpoint assignment unvalidated',
    find: "if (typeof value !== 'number' || !Number.isFinite(value)) {",
    replace: 'if (false) {',
  },
  {
    name: 'bound assignment accepts NaN',
    find: "if (typeof value !== 'number' || Number.isNaN(value)) {",
    replace: 'if (typeof value !== "number") {',
  },
  {
    name: 'inverted range accepted on assignment',
    find: 'if (next > this._max) {',
    replace: 'if (false) {',
  },
  {
    name: 'integral clamp division may overflow',
    find: 'const quotient = numerator / denominator;\n  return Number.isFinite(quotient) ? quotient : 0;',
    replace: 'return numerator / denominator;',
  },
  {
    // The real defect this guards is the one the docblock argues about: clamping
    // the *integral* rather than its *contribution* needs a second branch to
    // stay correct when `ki` is negative, because the window inverts. Skipping
    // the clamp for negative `ki` is what that mistake looks like in practice.
    name: 'integral clamp skipped when ki is negative',
    find: 'if (contribution < lo) this._integral = divideOrZero(lo, this._ki);\n      else if (contribution > hi) this._integral = divideOrZero(hi, this._ki);',
    replace:
      'if (this._ki > 0) {\n        if (contribution < lo) this._integral = divideOrZero(lo, this._ki);\n        else if (contribution > hi) this._integral = divideOrZero(hi, this._ki);\n      }',
  },
  {
    name: 'non-finite measurement absorbed rather than refused',
    find: 'if (!Number.isFinite(measured)) {',
    replace: 'if (false) {',
  },
  {
    name: 'non-finite feedforward contribution absorbed',
    find: "if (typeof contribution !== 'number' || !Number.isFinite(contribution)) {",
    replace: 'if (false) {',
  },
];

const source = readFileSync(join(ROOT, SUBJECT), 'utf8');

const selected = MUTANTS.filter((m) => (only ? m.name.includes(only) : true));

// Fail loudly on a drifted source rather than reporting a meaningless table.
for (const m of selected) {
  const hits = source.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`mutant anchor does not occur exactly once (${hits}): ${m.name}`);
    console.error(`  ${JSON.stringify(m.find.slice(0, 90))}`);
    process.exit(2);
  }
}

const temp = mkdtempSync(join(tmpdir(), 'servo-mutants-'));
try {
  cpSync(join(ROOT, 'src'), join(temp, 'src'), { recursive: true });
  cpSync(join(ROOT, 'test'), join(temp, 'test'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(temp, 'node_modules'), 'dir');
  // A minimal config: the repository's own pulls in a globalSetup that shells
  // out to the UMD build, which is irrelevant here and would add a minute per
  // mutant.
  writeFileSync(
    join(temp, 'vitest.config.mutants.js'),
    `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['${TEST}'] } });\n`
  );
  writeFileSync(
    join(temp, 'package.json'),
    JSON.stringify({ name: 'mutant-harness', type: 'module' })
  );

  // A fixed scenario whose output is the mutant's fingerprint. Every scenario
  // here exists because a mutant targets it: the digest has to *discriminate*, or
  // a real mutant looks inert. Each guarded behaviour gets a case that reaches
  // it — an explicit `dt` that differs from the default, `ki` together with a
  // feedforward term, a denormal `ki`, an assignment of `NaN` in each of the
  // three validated fields, and both refusal paths. `push` records a throw as a
  // value, so "refused" and "absorbed" cannot digest the same.
  writeFileSync(
    join(temp, 'digest.mjs'),
    `import { PowerServo } from './src/index.js';
const r = [];
const push = (label, fn) => { try { r.push([label, fn()]); } catch (e) { r.push([label, 'threw:' + e.constructor.name]); } };
push('basic', () => { const s = new PowerServo({ setpoint: 100, kp: 0.5, ki: 0.5, min: 0, max: 8 });
  for (let i = 0; i < 12; i++) s.step(0, 1); return [s.integral, s.output, s.saturated]; });
push('setpoint-step-derivative', () => { const s = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
  s.step(100, 1); s.setpoint = 5000; s.step(100, 1); return [s.derivative, s.output]; });
push('falling-measurement', () => { const s = new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 1, min: -1e9, max: 1e9 });
  s.step(0, 1); s.step(100, 1); return s.derivative; });
push('zero-span', () => { const s = new PowerServo({ kd: 1, derivativeFilter: 0.5, dt: 0 });
  s.step(0, 0); s.step(1, 0); s.step(2, 0); return [s.derivative, s.output]; });
push('windup-release', () => { const s = new PowerServo({ setpoint: 100, kp: 0.5, ki: 2, max: 8, min: 0 });
  for (let i = 0; i < 50; i++) s.step(0, 1); const pinned = s.integral; s.step(100, 1);
  return [pinned, s.integral, s.output]; });
push('reverse-ki', () => { const s = new PowerServo({ setpoint: 100, kp: 0.5, ki: -2, min: 0, max: 8 });
  for (let i = 0; i < 20; i++) s.step(0, 1); return [s.integral, s.output]; });
push('feedforward-gain', () => new PowerServo({ setpoint: 0, kp: 0, ki: 0, kd: 0, min: -1e6, max: 1e6, feedforwardGain: 2 }).step(0, 1, 5));
push('feedforward-with-integral', () => { const s = new PowerServo({ setpoint: 10, kp: 0, ki: 1, min: 0, max: 8, feedforwardGain: 100 });
  for (let i = 0; i < 10; i++) s.step(0, 1, 1); return [s.integral, s.output]; });
push('unbounded', () => new PowerServo({ setpoint: 0, kp: 1, ki: 0, kd: 0 }).step(-1e12, 1));
push('dt-default', () => { const s = new PowerServo({ setpoint: 0, kp: 0, ki: 1, min: -1e9, max: 1e9 });
  s.setpoint = 10; s.step(0); return s.integral; });
push('dt-explicit-override', () => { const s = new PowerServo({ setpoint: 10, kp: 0, ki: 1, dt: 1, min: -1e9, max: 1e9 });
  return [s.step(0, 4), s.integral]; });
push('dt-explicit-zero', () => { const s = new PowerServo({ setpoint: 10, kp: 0.5, ki: 1, dt: 1, min: -1e9, max: 1e9 });
  return [s.step(0, 0), s.integral, s.output]; });
push('denormal-ki', () => { const s = new PowerServo({ setpoint: 100, kp: 0.5, ki: 1e-320, min: 0, max: 8 });
  for (let i = 0; i < 60; i++) s.step(0, 1); return [s.integral, s.output]; });
push('setpoint-nan', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e9, max: 1e9 });
  s.setpoint = NaN; return s.step(0, 1); });
push('setpoint-infinity', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e9, max: 1e9 });
  s.setpoint = Infinity; return s.step(0, 1); });
push('max-nan', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
  s.max = NaN; for (let i = 0; i < 20; i++) s.step(999, 100); return [s.integral, s.output]; });
push('min-nan', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
  s.min = NaN; return s.step(0, 100); });
push('range-inverted-from-outside', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
  s.max = -50; for (let i = 0; i < 20; i++) s.step(999, 100); return [s.integral, s.output]; });
push('min-above-max', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 0.5, min: 0, max: 100 });
  s.min = 500; return s.step(0, 100); });
push('measured-nan', () => new PowerServo({ setpoint: 1, kp: 1, ki: 1, kd: 1 }).step(NaN, 1));
push('measured-infinity', () => new PowerServo({ setpoint: 1, kp: 1, ki: 1, kd: 1 }).step(Infinity, 1));
push('feedforward-nan', () => new PowerServo({ setpoint: 0, kp: 1, ki: 1, kd: 0, feedforward: () => NaN }).step(0, 1));
push('feedforward-ctx', () => { const seen = []; const s = new PowerServo({ setpoint: 10, kp: 1, ki: 0, kd: 0, min: -1e6, max: 1e6,
  feedforward: (c) => { seen.push({ ...c }); return 0; } });
  s.step(2, 1, 7); s.step(3, 1, 8); return seen; });
push('reset-keeps-config', () => { const s = new PowerServo({ setpoint: 10, kp: 0.5, ki: 2, min: 1, max: 99 });
  s.step(0, 1); s.step(0, 1); s.reset(); return [s.integral, s.output, s.setpoint, s.min, s.max]; });
push('dispose-resets', () => { const s = new PowerServo({ setpoint: 10, kp: 1, ki: 1, min: -1e9, max: 1e9 });
  s.step(0, 1); s.dispose(); return s.integral; });
console.log(JSON.stringify(r));
`
  );

  function digestSource() {
    const out = spawnSync('node', [join(temp, 'digest.mjs')], { cwd: temp, encoding: 'utf8' });
    return (out.stdout || `error:${out.stderr}`).trim();
  }

  const results = [];
  for (const m of selected) {
    writeFileSync(join(temp, SUBJECT), source);
    const before = digestSource();
    writeFileSync(join(temp, SUBJECT), source.replace(m.find, m.replace));
    const after = digestSource();
    // **Is the mutant even a mutant?** A replacement that is algebraically
    // identical to what it replaced — or that introduces an unused binding —
    // leaves behaviour untouched, so the suite passes and the mutant is reported
    // as a survivor. That reads exactly like a coverage gap, and it is how a
    // mutation harness starts lying: two of the eighteen here were inert on the
    // first run for precisely that reason. So the observable behaviour is
    // digested before and after, and an unchanged digest is reported as INERT
    // rather than SURVIVED. An inert mutant is a bug in this file.
    if (before === after) {
      results.push({ ...m, killed: false, inert: true });
      console.log(`INERT    ${m.name}  [behaviour unchanged — the mutant is a no-op]`);
      continue;
    }
    const run = spawnSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.config.mutants.js', '--reporter', 'dot'],
      { cwd: temp, encoding: 'utf8', timeout: 300000 }
    );
    const killed = run.status !== 0;
    results.push({ ...m, killed, inert: false, status: run.status });
    const failing = killed ? (run.stdout.match(/Tests\s+(\d+) failed/) || [])[1] : null;
    console.log(
      `${killed ? 'KILLED  ' : 'SURVIVED'}  ${m.name}` +
        (verbose || (!killed && failing) ? `  [${failing ?? 0} failing tests]` : '')
    );
  }

  const survivors = results.filter((r) => !r.killed && !r.inert);
  const inert = results.filter((r) => r.inert);
  console.log(`\n${results.length - survivors.length - inert.length}/${results.length} killed`);
  if (inert.length > 0) {
    console.error('\nInert mutants — these do not change behaviour, so they prove nothing:');
    for (const s of inert) console.error(`  ${s.name}`);
  }
  if (survivors.length > 0) {
    console.error('\nSurvivors — the suite no longer covers these:');
    for (const s of survivors) console.error(`  ${s.name}`);
  }
  if (survivors.length > 0 || inert.length > 0) process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
