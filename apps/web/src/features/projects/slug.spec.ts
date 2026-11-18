import { projectSlugSchema } from '@agentos/contracts';
import { describe, expect, it } from 'vitest';
import { SLUG_MAX_LENGTH, suggestSlug } from './slug';

describe('suggestSlug', () => {
  it.each([
    ['Platform Rewrite', 'platform-rewrite'],
    ['  Platform   Rewrite  ', 'platform-rewrite'],
    ['2026 Plan', '2026-plan'],
    ['Café Münch', 'cafe-munch'],
    ['Hello, World! (v2)', 'hello-world-v2'],
    ['--Hello__World--', 'hello-world'],
    ['UPPER lower', 'upper-lower'],
    ['a/b\\c', 'a-b-c'],
  ])('turns %j into %j', (name, expected) => {
    expect(suggestSlug(name)).toBe(expected);
  });

  it('gives no suggestion when the name has no Latin letters or digits (for example Persian), rather than an invalid slug', () => {
    expect(suggestSlug('پروژه نمونه')).toBe('');
    expect(suggestSlug('   ')).toBe('');
    expect(suggestSlug('!!!')).toBe('');
  });

  it('gives no suggestion for a single character, which the API would refuse (at least 2)', () => {
    expect(suggestSlug('A')).toBe('');
    expect(suggestSlug('a!')).toBe('');
    expect(suggestSlug('Ab')).toBe('ab');
  });

  it("cuts at the API's maximum without leaving a trailing hyphen", () => {
    const long = suggestSlug('x'.repeat(60));
    expect(long).toHaveLength(SLUG_MAX_LENGTH);
    expect(suggestSlug('x'.repeat(SLUG_MAX_LENGTH - 1) + ' yyyy')).toBe('x'.repeat(SLUG_MAX_LENGTH - 1)); // the cut fell on the hyphen
  });

  it('only ever returns an empty string or a slug the contract accepts', () => {
    const samples = [
      'Platform Rewrite',
      'Ünïcödé Näme',
      '日本語 project',
      '---',
      'a',
      'ab',
      '  x  y  ',
      'A'.repeat(200),
      '9',
      '99',
      'name-with-hyphens',
      'name--double',
      'Mixed_CASE and.dots',
      '🚀 launch',
      'عنوان 2 پروژه',
      '٣٤٥',
      'a'.repeat(47) + '-b',
    ];
    for (const sample of samples) {
      const slug = suggestSlug(sample);
      if (slug !== '') expect(projectSlugSchema.safeParse(slug).success, `${sample} -> ${slug}`).toBe(true);
    }
  });

  it("matches the contract's maximum", () => {
    expect(projectSlugSchema.safeParse('a'.repeat(SLUG_MAX_LENGTH)).success).toBe(true);
    expect(projectSlugSchema.safeParse('a'.repeat(SLUG_MAX_LENGTH + 1)).success).toBe(false);
  });
});
