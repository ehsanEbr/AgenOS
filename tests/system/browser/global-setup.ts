import { Stack, buildImages, currentRevision, verifyImageProvenance } from '../src/stack';
import { Api } from './support/api';
import { PERSON_KEYS, STACK_INFO_ENV, type PersonKey, type StackInfo } from './support/stack-info';

/**
 * Boots ONE throwaway stack for the whole browser run and destroys it afterwards (ADR-0012 D1).
 *
 * Images: like the Vitest system tests, the images are built for the CURRENT commit under the test tag (`agentos-*:systest`, never a
 * developer's `:local` images) and their provenance is verified. `SYSTEST_SKIP_BUILD=1` skips the build, not the check. The `browser`
 * CI job builds its own images (ADR-0012 open question Q3): it shares nothing with the `system` job, at the cost of building twice.
 *
 * People: registration is limited to 5 per hour per client address and EVERY attempt counts (`identity/domain/throttle-policy.ts`), and
 * the whole run comes from one address. Three people are therefore registered once here and shared; the sign-up test registers a
 * fourth through the UI. Signing in is not limited (only failed attempts count). A test never changes who these people are: it builds
 * its own organization and gives them roles in it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const skip = process.env.SYSTEST_SKIP_BUILD === '1';
  const revision = await currentRevision();
  const records = skip ? await verifyImageProvenance() : await buildImages();
  console.log(
    `browser-test images (${skip ? 'build SKIPPED, provenance verified' : 'built'}) for revision ${revision}`,
  );
  for (const record of records)
    console.log(
      `  ${record.reference}  ${record.id}  created ${record.created}  revision ${record.revision}`,
    );

  // The API accepts the state-changing requests of a browser only from its configured origin: http://localhost:<web port>.
  const stack = await Stack.create({ env: { AUTH_ALLOW_REGISTRATION: 'true' } });
  try {
    await stack.up(['api', 'web']);
    const origin = `http://localhost:${stack.ports.web}`;
    const api = new Api(origin);

    const run = Math.random().toString(36).slice(2, 8);
    const names: Record<PersonKey, string> = { ada: 'Ada Lovelace', bob: 'Bob Builder', cara: 'Cara Viewer' };
    const people = {} as StackInfo['people'];
    for (const key of PERSON_KEYS) people[key] = await api.register(names[key], `${key}.${run}@example.com`);

    const info: StackInfo = {
      project: stack.project,
      webOrigin: origin,
      migratePassword: stack.migratePassword,
      people,
    };
    process.env[STACK_INFO_ENV] = JSON.stringify(info);
    console.log(`browser-test stack ${stack.project} is up at ${origin}`);
  } catch (error) {
    await stack.destroy(); // never leave a half-started stack (or its generated credentials) behind
    throw error;
  }

  return async () => {
    delete process.env[STACK_INFO_ENV];
    await stack.destroy();
  };
}
