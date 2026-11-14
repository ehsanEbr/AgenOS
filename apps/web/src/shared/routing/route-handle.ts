/**
 * Metadata a route declares through React Router's `handle`. The shell reads it for the document title and the
 * screen-reader announcement on navigation. Add fields here only when something in the shell consumes them.
 */
export interface RouteHandle {
  /** i18n key including its namespace, e.g. `home:title`. Must exist in every supported locale (a test checks). */
  titleKey: string;
}

export function isRouteHandle(value: unknown): value is RouteHandle {
  return typeof value === 'object' && value !== null && typeof (value as RouteHandle).titleKey === 'string';
}
