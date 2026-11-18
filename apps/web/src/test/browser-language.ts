import { vi } from 'vitest';

/**
 * A browser that prefers these languages, as BOTH `navigator.languages` and `navigator.language` report it, so a test of the language
 * a visitor starts with fails whichever of the two the code under test reads. The spies are undone by `vi.restoreAllMocks()` in the
 * test setup after each test.
 */
export function browserPrefers(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '');
}
