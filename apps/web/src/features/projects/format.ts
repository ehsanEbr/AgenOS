/** A date in the language of the interface (calendar and digits follow the locale), or an empty string for something that is no date. */
export function formatDate(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
}
