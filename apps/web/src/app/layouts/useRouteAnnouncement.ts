import { type RefObject, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useMatches } from 'react-router';
import { isRouteHandle } from '../../shared/routing/route-handle';

/**
 * Makes client-side navigation perceivable, which the browser does not do for single-page apps:
 *  1. `document.title` follows the current route (`handle.titleKey`), so tabs, history and screen readers see it.
 *  2. After a navigation, focus moves to the main region, so keyboard and screen-reader users start at the new content
 *     instead of being left on the link they activated. The first render is skipped to not steal initial focus.
 */
export function useRouteAnnouncement(mainRef: RefObject<HTMLElement | null>): void {
  const { t, i18n } = useTranslation();
  const { pathname } = useLocation();
  const matches = useMatches();
  const isFirstRender = useRef(true);

  const handle = [...matches].reverse().find((m) => isRouteHandle(m.handle))?.handle;
  const titleKey = isRouteHandle(handle) ? handle.titleKey : undefined;

  useEffect(() => {
    const translate = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    document.title = titleKey
      ? translate('shell:documentTitle', { page: translate(titleKey) })
      : translate('shell:brand');
  }, [t, titleKey, i18n.language]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [pathname, mainRef]);
}
