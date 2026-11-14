#!/usr/bin/env node
// Enforces two backend module rules that ESLint cannot express reliably:
//
//  1. No circular dependencies between modules (a -> b -> a, or longer).
//  2. A module may import another module only through its public entry (`../other` or `../other/index`), never its
//     internal files. This check is depth-agnostic: it resolves every relative import to its target module, so it
//     works from flat modules (`../b/x`) and from layered ones (`../../b/x`, `../../../b/x`) alike.
//
// Graph source: relative imports under apps/api/src/modules/<module>/**. Spec/test files are ignored, and imports of
// anything outside modules/ (common/, packages) are not edges.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts'))
      yield full;
  }
}

/**
 * @returns {{ graph: Map<string, Set<string>>, internalImports: { file: string, specifier: string, from: string, to: string }[] }}
 */
export function analyzeModules(modulesDir) {
  const root = resolve(modulesDir);
  const graph = new Map();
  const internalImports = [];
  for (const name of readdirSync(root)) {
    if (statSync(join(root, name)).isDirectory()) graph.set(name, new Set());
  }

  for (const [name, edges] of graph) {
    for (const file of sourceFiles(join(root, name))) {
      const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles;
      for (const { fileName: specifier } of imports) {
        if (!specifier.startsWith('.')) continue;
        const [targetModule, ...rest] = relative(root, resolve(dirname(file), specifier)).split(sep);
        if (!targetModule || targetModule === '..' || targetModule === name || !graph.has(targetModule))
          continue;

        edges.add(targetModule);
        const isPublicEntry = rest.length === 0 || (rest.length === 1 && rest[0] === 'index');
        if (!isPublicEntry) {
          internalImports.push({
            file: relative(root, file).split(sep).join('/'), // same output on every OS
            specifier,
            from: name,
            to: targetModule,
          });
        }
      }
    }
  }
  return { graph, internalImports };
}

export const buildModuleGraph = (modulesDir) => analyzeModules(modulesDir).graph;

/** @returns {string[][]} each cycle as a list of module names, first == last */
export function findCycles(graph) {
  const cycles = [];
  const state = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
  const stack = [];

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const modulesDir = resolve(
    process.argv[2] ?? join(import.meta.dirname, '..', 'apps', 'api', 'src', 'modules'),
  );
  if (!existsSync(modulesDir)) {
    console.error(`Modules directory not found: ${modulesDir}`);
    process.exit(2);
  }
  const { graph, internalImports } = analyzeModules(modulesDir);
  const cycles = findCycles(graph);
  const summary = [...graph].map(([m, deps]) => `${m} -> ${[...deps].join(', ') || '(none)'}`).join('\n  ');

  if (cycles.length > 0 || internalImports.length > 0) {
    if (cycles.length > 0) {
      console.error('Circular module dependencies found:');
      for (const cycle of cycles) console.error(`  ${cycle.join(' -> ')}`);
    }
    if (internalImports.length > 0) {
      console.error("Imports into another module's internals (import through its index instead):");
      for (const i of internalImports) console.error(`  ${i.file}: '${i.specifier}'  (${i.from} -> ${i.to})`);
    }
    console.error(`\nModule graph:\n  ${summary}`);
    process.exit(1);
  }
  console.log(`Module boundaries OK: no cycles, no internal imports (${graph.size} modules).\n  ${summary}`);
}
