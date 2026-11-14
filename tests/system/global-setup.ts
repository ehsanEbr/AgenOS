import { buildImages } from './src/stack';

/** Builds the images once before any system test. Layers are cached, so a second run is fast. Set SYSTEST_SKIP_BUILD=1 to reuse images already built. */
export default async function setup(): Promise<void> {
  if (process.env.SYSTEST_SKIP_BUILD === '1') return;
  await buildImages();
}
