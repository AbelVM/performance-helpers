import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every markdown link in the repository resolves.
 *
 * This exists because of `assets/navigation.md`. It was written with links
 * relative to the repository root — `docs/README.md`, `assets/1_Caching.md`,
 * `guides/metaGuide.md` — while the file itself lives in `assets/`. Not one of
 * its eleven links resolved, so the site's navigation bar was dead. The review
 * had recorded exactly one of them (`DEAD-003` flagged `[API](docs/README.md)`)
 * on the assumption that only that one was wrong, which is the kind of
 * assumption that leaves the other ten in place.
 *
 * The tell is that the neighbouring pages got it right: `assets/1_Caching.md`
 * links with `../guides/powerCache.md`. One directory, two conventions.
 *
 * So: check them all, from the file that contains the link, and fail with the
 * offending path rather than a count.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose markdown is documentation, not vendored output. */
const SCAN = ['README.md', 'CONTRIBUTING.md', 'guides', 'assets', 'adr', 'examples'];

/** `docs/` is generated typedoc output; `node_modules` is not ours. */
const SKIP = new Set(['node_modules', 'docs', 'dist', '.git', 'bench', '.kilo', 'test']);

function collect() {
  const files = [];
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(next);
      } else if (entry.name.endsWith('.md')) {
        files.push(next);
      }
    }
  };
  for (const entry of SCAN) {
    if (entry.endsWith('.md')) files.push(entry);
    else walk(entry);
  }
  return files;
}

const FILES = collect();

describe('documentation links', () => {
  it('found the documentation to check', () => {
    // A glob that silently matches nothing would make every test below
    // vacuously true, which is the failure mode this file exists to catch.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES).toContain('assets/navigation.md');
  });

  it.each(FILES)('%s has no broken relative links', (rel) => {
    const abs = join(root, rel);
    const text = readFileSync(abs, 'utf8');
    const dir = dirname(abs);
    const broken = [];

    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = m[1].trim();
      // Skip URLs, anchors and mailto - they resolve outside the repository.
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
      const [pathPart] = target.split('#');
      if (!pathPart) continue;
      const resolvedPath = pathPart.startsWith('/')
        ? join(root, pathPart.slice(1))
        : resolve(dir, pathPart);
      if (!existsSync(resolvedPath)) {
        // The single most common form of this bug: a path written relative to
        // the repository root inside a file that is not at the root.
        const fromRoot = join(root, pathPart);
        broken.push(
          existsSync(fromRoot) ? `${target} (resolves from the repo root, not from ${rel})` : target
        );
      }
    }
    expect(broken, `broken links in ${rel}`).toEqual([]);
  });
});
