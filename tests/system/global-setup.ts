import { buildImages, currentRevision, verifyImageProvenance } from './src/stack';

/**
 * Builds the images for the CURRENT commit under the test tag (`agentos-*:systest`, never a developer's `:local` images) and
 * verifies each carries this commit as its revision label. Prints the evidence (image ID, creation time, revision) so a test run
 * documents exactly which images it used.
 *
 * SYSTEST_SKIP_BUILD=1 skips the build but NOT the check: only images that were built from this exact commit are accepted, so a
 * stale image, or one built by something else, cannot be reused by accident.
 */
export default async function setup(): Promise<void> {
  const skip = process.env.SYSTEST_SKIP_BUILD === '1';
  const revision = await currentRevision();
  const records = skip ? await verifyImageProvenance() : await buildImages();
  console.log(
    `system-test images (${skip ? 'build SKIPPED, provenance verified' : 'built'}) for revision ${revision}`,
  );
  for (const record of records)
    console.log(
      `  ${record.reference}  ${record.id}  created ${record.created}  revision ${record.revision}`,
    );
}
