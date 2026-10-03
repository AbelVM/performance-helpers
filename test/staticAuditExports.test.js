/**
 * `scripts/static-audit-exports.cjs` must emit **one** JSON document.
 *
 * GATE-013. The script printed the same object twice — a `process.stdout.write`
 * followed by a `console.log` of the identical value — so the invocation its own
 * comment recommends, `npm run audit:exports > /tmp/exports.json`, produced
 * 368,288 bytes containing two concatenated documents, and `JSON.parse` rejected
 * it at position 184,144.
 *
 * **Why this needs a test at all.** The output is only ever consumed by a human
 * redirecting it to a file, so nothing in `verify` ever parsed it and the defect
 * was invisible to every gate in the repo. It is exactly the class of thing that
 * rots: the second write was almost certainly left behind when the output moved
 * off a committed snapshot file, and the cost was a diagnostic nobody could load.
 * A guard that runs the real command and parses its real output is the only thing
 * that closes it.
 *
 * Spawned as a subprocess rather than imported, because the output is the artefact
 * under test — importing the module would exercise the code path while bypassing
 * the thing that was broken.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

describe('static-audit-exports emits exactly one JSON document', () => {
  it('produces output that JSON.parse accepts', async () => {
    // `maxBuffer` is raised because the report is ~180 kB and the default 1 MB
    // would leave no headroom if the export list grows.
    const { stdout } = await run('node', ['scripts/static-audit-exports.cjs'], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });

    // The whole point: one document. `JSON.parse` throws on trailing content, so
    // this fails on the duplication without needing to count braces — which is the
    // assertion that would have passed on the broken version by counting only the
    // first document.
    let parsed;
    expect(() => {
      parsed = JSON.parse(stdout);
    }).not.toThrow();

    // And it is the audit, not `{}` that happens to parse. A snapshot of the shape
    // is what makes the parse assertion mean something.
    expect(Object.keys(parsed).sort()).toEqual(['generatedAt', 'report']);
    expect(Object.keys(parsed.report).length).toBeGreaterThan(100);
  }, 60_000);

  it('does not emit the document twice', async () => {
    // A second, independent check on the same defect, because the failure mode is
    // specifically *duplication* and the parse assertion above reports it as a
    // parse error, which says nothing about where it came from. Counting the
    // distinctive top-level key is the narrowest statement of "once".
    const { stdout } = await run('node', ['scripts/static-audit-exports.cjs'], {
      cwd: ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    const occurrences = stdout.split('"generatedAt"').length - 1;
    expect(occurrences).toBe(1);
  }, 60_000);
});
