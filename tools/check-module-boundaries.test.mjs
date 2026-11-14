import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { analyzeModules, buildModuleGraph, findCycles } from './check-module-boundaries.mjs';

const created = [];
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-modules-'));
  created.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
after(() => created.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('module graph', () => {
  it('records imports between modules, including deep paths, and ignores self, external and spec imports', () => {
    const dir = fixture({
      'a/index.ts':
        "import { b } from '../b';\nimport { z } from 'zod';\nimport './internal';\nimport '../../common/x';",
      'a/internal.ts': 'export const x = 1;',
      'a/a.spec.ts': "import '../c/index';",
      'b/index.ts': "import '../c/deep/file';",
      'c/index.ts': 'export {};',
      'c/deep/file.ts': 'export {};',
    });
    const graph = buildModuleGraph(dir);
    assert.deepEqual([...graph.get('a')], ['b']);
    assert.deepEqual([...graph.get('b')], ['c']);
    assert.deepEqual([...graph.get('c')], []);
  });
});

describe('internal imports', () => {
  it('allows the public entry (module root or index) from any depth', () => {
    const dir = fixture({
      'a/index.ts': "import '../b';\nimport '../b/index';",
      'a/domain/entity.ts': "import '../../b';",
      'a/application/deep/svc.ts': "import '../../../b/index';",
      'b/index.ts': 'export {};',
    });
    assert.deepEqual(analyzeModules(dir).internalImports, []);
  });

  it("rejects imports of a sibling module's internal files from flat and layered modules", () => {
    const dir = fixture({
      'a/flat.ts': "import '../b/secret';",
      'a/application/svc.ts': "import '../../b/infrastructure/repo';",
      'a/application/deep/svc2.ts': "import '../../../b/domain/entity';",
      'b/index.ts': 'export {};',
      'b/secret.ts': 'export {};',
      'b/infrastructure/repo.ts': 'export {};',
      'b/domain/entity.ts': 'export {};',
    });
    const found = analyzeModules(dir).internalImports.map((i) => `${i.file} -> ${i.to}`);
    assert.deepEqual(found.sort(), [
      'a/application/deep/svc2.ts -> b',
      'a/application/svc.ts -> b',
      'a/flat.ts -> b',
    ]);
  });

  it('does not flag imports inside the same module', () => {
    const dir = fixture({
      'a/application/svc.ts': "import '../domain/entity';\nimport '../infrastructure/repo';",
      'a/domain/entity.ts': 'export {};',
      'a/infrastructure/repo.ts': 'export {};',
    });
    assert.deepEqual(analyzeModules(dir).internalImports, []);
  });
});

describe('cycle detection', () => {
  it('accepts a directed acyclic graph', () => {
    const graph = new Map([
      ['a', new Set(['b', 'c'])],
      ['b', new Set(['c'])],
      ['c', new Set()],
    ]);
    assert.deepEqual(findCycles(graph), []);
  });

  it('finds a direct cycle', () => {
    const dir = fixture({ 'a/index.ts': "import '../b';", 'b/index.ts': "import '../a';" });
    assert.deepEqual(findCycles(buildModuleGraph(dir)), [['a', 'b', 'a']]);
  });

  it('finds a cycle between layered modules', () => {
    const dir = fixture({
      'a/application/svc.ts': "import '../../b';",
      'b/application/svc.ts': "import '../../a';",
    });
    assert.deepEqual(findCycles(buildModuleGraph(dir)), [['a', 'b', 'a']]);
  });

  it('finds a longer cycle and reports its path', () => {
    const graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set(['a'])],
    ]);
    assert.deepEqual(findCycles(graph), [['a', 'b', 'c', 'a']]);
  });
});
