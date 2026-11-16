import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * Where trusted scopes and contexts may be CONSTRUCTED (ADR-0011, decision 5).
 *
 * A repository demands a scope and a request acts through a context; both are only as trustworthy as the code that builds them. This test
 * scans every non-test source file under apps/api/src and finds each call or `new` of the construction functions below. The set of
 * (file, function) pairs must EQUAL a pinned allowlist, so a controller, a guard, a repository, a domain file or another module that
 * starts building a scope fails here, naming the file and line. Adding a legitimate call site means editing this list, which shows up in
 * review.
 *
 * What it does NOT prove: that the id passed is the right one. It pins WHERE scopes are built; the cross-tenant test matrix
 * (organizations.int.spec.ts, projects.int.spec.ts) is the control for which id.
 */

const SRC = resolve(__dirname, '../src');

/** Functions and static factories whose call sites are restricted. */
const RESTRICTED = [
  'scopeOf',
  'OrganizationScope.of',
  'projectScopeOf',
  'ProjectScope.of',
  'ProjectContext.create',
  'OrganizationContext.create',
  'new OrganizationScope',
  'new ProjectScope',
  'new ProjectContext',
  'new OrganizationContext',
] as const;

/** The only places that may call them, with the exact set of functions each may call. Paths are relative to apps/api/src. */
const ALLOWED: Record<string, readonly (typeof RESTRICTED)[number][]> = {
  // organizations: the definition of its scope, and the two application services that derive scopes from a validated TenantContext
  'modules/organizations/domain/tenant.ts': ['OrganizationScope.of', 'new OrganizationScope'],
  'modules/organizations/application/organization.service.ts': ['scopeOf'],
  'modules/organizations/application/membership.service.ts': ['scopeOf'],
  // projects: the definitions of its contexts and scopes (the only derivations) ...
  'modules/projects/domain/project-context.ts': [
    'scopeOf',
    'projectScopeOf',
    'ProjectScope.of',
    'new OrganizationContext',
    'new ProjectScope',
    'new ProjectContext',
  ],
  // ... and the ONE place that creates a context, from what it has just read from the database
  'modules/projects/application/project-access.ts': ['OrganizationContext.create', 'ProjectContext.create'],
};

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.tsx?$/.test(entry) && !/\.(spec|test)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts'))
      yield full;
  }
}

interface Site {
  readonly file: string;
  readonly line: number;
  readonly what: (typeof RESTRICTED)[number];
}

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const full of sourceFiles(SRC)) {
    const file = relative(SRC, full).split(sep).join('/');
    const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let name: string | undefined;
      if (ts.isCallExpression(node)) name = node.expression.getText(source);
      else if (ts.isNewExpression(node)) name = `new ${node.expression.getText(source)}`;
      if (name && (RESTRICTED as readonly string[]).includes(name))
        sites.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          what: name as (typeof RESTRICTED)[number],
        });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

describe('trusted scopes are built only where they are allowed to be', () => {
  const sites = callSites();

  it('finds the call sites it is meant to police (the scan is not silently empty)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
    expect(new Set(sites.map((site) => site.what)).size).toBeGreaterThanOrEqual(4);
  });

  it('has no call site outside the pinned allowlist: no controller, guard, repository, other service or other module builds a scope', () => {
    const outside = sites.filter((site) => !(ALLOWED[site.file] ?? []).includes(site.what));
    expect(outside.map((site) => `${site.file}:${site.line} calls ${site.what}`)).toEqual([]);
  });

  it('uses every allowlisted entry (a stale entry would hide a future violation)', () => {
    const used = new Set(sites.map((site) => `${site.file} ${site.what}`));
    const unused = Object.entries(ALLOWED).flatMap(([file, functions]) =>
      functions.filter((fn) => !used.has(`${file} ${fn}`)).map((fn) => `${file} ${fn}`),
    );
    expect(unused).toEqual([]);
  });

  it('keeps context creation in a single projects file: ProjectAccess', () => {
    const creators = sites.filter(
      (site) => site.what === 'ProjectContext.create' || site.what === 'OrganizationContext.create',
    );
    expect([...new Set(creators.map((site) => site.file))]).toEqual([
      'modules/projects/application/project-access.ts',
    ]);
  });
});
