import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { analyzeModules } from './check-module-boundaries.mjs';

/*
 * The web architecture rule of ADR-0012 D4 (rule 5), checked against the REAL repository ESLint configuration with planted
 * violations: private data is fetched only through the session-gated observer path, so the imperative TanStack Query calls are
 * banned everywhere in apps/web except features/auth (and tests).
 */

const root = join(fileURLToPath(import.meta.url), '..', '..');
const eslint = new ESLint({ cwd: root });

async function violations(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
}

const METHODS = [
  'fetchQuery',
  'prefetchQuery',
  'ensureQueryData',
  'fetchInfiniteQuery',
  'prefetchInfiniteQuery',
  'ensureInfiniteQueryData',
  'refetchQueries',
  'setQueryData',
  'setQueriesData',
];
const planted = (method) => `export const f = (client) => client.${method}({ queryKey: ['projects'] });\n`;

describe('imperative query calls in apps/web', () => {
  for (const place of [
    'apps/web/src/features/projects/queries.ts',
    'apps/web/src/features/health/queries.ts',
    'apps/web/src/app/providers/query-client.ts',
    'apps/web/src/shared/api/helper.ts',
  ])
    it(`are rejected in ${place}`, async () => {
      for (const method of METHODS) {
        const found = await violations(planted(method), place);
        assert.equal(found.length, 1, `${method} was not rejected in ${place}`);
        assert.match(found[0], /ADR-0012/);
      }
    });

  it('are allowed in features/auth (the session core), in source and in specs', async () => {
    for (const method of METHODS) {
      assert.deepEqual(await violations(planted(method), 'apps/web/src/features/auth/session-probe.ts'), []);
    }
  });

  it('are allowed in spec files and in test helpers anywhere (tests drive the client directly)', async () => {
    for (const method of METHODS) {
      assert.deepEqual(await violations(planted(method), 'apps/web/src/features/projects/x.spec.ts'), []);
      assert.deepEqual(await violations(planted(method), 'apps/web/src/test/helper.ts'), []);
    }
  });

  it('do not catch the permitted observer path or read-only cache access', async () => {
    const code = [
      "import { useQuery, useQueryClient } from '@tanstack/react-query';",
      'export function useThing() {',
      '  const client = useQueryClient();',
      "  const read = client.getQueryData(['projects']);",
      "  void client.invalidateQueries({ queryKey: ['projects'] });",
      "  const query = useQuery({ queryKey: ['projects'], queryFn: async () => read });",
      '  return query.refetch();',
      '}',
      '',
    ].join('\n');
    assert.deepEqual(await violations(code, 'apps/web/src/features/projects/queries.ts'), []);
  });

  it('keeps the existing import.meta.env rule in force next to the new one', async () => {
    const found = await violations(
      'export const x = import.meta.env.MODE;\n',
      'apps/web/src/features/projects/x.ts',
    );
    assert.equal(found.length, 1);
    assert.match(found[0], /env/);
    assert.deepEqual(
      await violations('export const x = import.meta.env.MODE;\n', 'apps/web/src/features/auth/x.ts'),
      [found[0]],
    );
  });
});

/*
 * The boundary of the authentication-mutation exemption (ADR-0012 D4 rule 5): the marker lives in features/auth/auth-mutation.ts,
 * which is internal to the feature. Nothing else may import it, so a private feature mutation cannot claim the exemption.
 */
const created = [];
function featuresFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-features-'));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
after(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function importViolations(code, filePath) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('the authentication-mutation exemption boundary', () => {
  it('a feature importing the marker module of another feature is reported as an internal import (planted violation)', () => {
    const dir = featuresFixture({
      'auth/index.ts': 'export {};',
      'auth/auth-mutation.ts': 'export const asAuthMutation = (o) => o;',
      'projects/queries.ts':
        "import { asAuthMutation } from '../auth/auth-mutation';\nexport const x = asAuthMutation;",
    });
    const { internalImports } = analyzeModules(dir);
    assert.deepEqual(
      internalImports.map((i) => [i.from, i.to, i.specifier]),
      [['projects', 'auth', '../auth/auth-mutation']],
    );
  });

  it('the public entry of a feature is still importable by another feature (the check is not a blanket ban)', () => {
    const dir = featuresFixture({
      'auth/index.ts': 'export const useCurrentUser = () => null;',
      'projects/queries.ts': "import { useCurrentUser } from '../auth';\nexport const x = useCurrentUser;",
    });
    assert.deepEqual(analyzeModules(dir).internalImports, []);
  });

  it('in the real tree, no feature other than auth imports anything internal to features/auth', () => {
    const { internalImports } = analyzeModules(join(root, 'apps', 'web', 'src', 'features'));
    assert.deepEqual(
      internalImports.filter((i) => i.to === 'auth'),
      [],
    );
  });

  it('the application layer cannot import the marker module either (ESLint, planted violation)', async () => {
    const found = await importViolations(
      "import { asAuthMutation } from '../features/auth/auth-mutation';\nexport const x = asAuthMutation;\n",
      'apps/web/src/app/providers/something.ts',
    );
    assert.equal(found.length, 1);
    assert.match(found[0], /public entry/);
  });

  it('the public entry of features/auth does not export the marker module', async () => {
    const { readFileSync } = await import('node:fs');
    // Code only: the index explains in a comment what it does not export, and the explanation is not an export.
    const index = readFileSync(join(root, 'apps', 'web', 'src', 'features', 'auth', 'index.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.doesNotMatch(index, /auth-mutation/);
    assert.doesNotMatch(index, /asAuthMutation|isAuthMutationMeta/);
  });
});
