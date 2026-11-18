/** The longest slug the API accepts (`projectSlugSchema`). */
export const SLUG_MAX_LENGTH = 48;

/**
 * Suggests a slug from a project name: lower-case letters, digits and single hyphens, as the API requires. Accents are folded to their
 * base letter ("Café" -> "cafe"); anything that is not a letter or digit (spaces, punctuation, other scripts) separates words.
 * The result is only a starting point the person can edit: a name with no Latin letters or digits (for example Persian) gives an empty
 * suggestion, never an invalid slug, and the person types one.
 */
export function suggestSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // the accents split off by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, ''); // cutting may leave a trailing hyphen
  return slug.length >= 2 ? slug : '';
}
