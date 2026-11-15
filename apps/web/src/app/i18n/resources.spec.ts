import { describe, expect, it } from 'vitest';
import { routes } from '../router/routes';
import { isRouteHandle } from '../../shared/routing/route-handle';
import { createI18n } from './create-i18n';
import { resources } from './resources';

/** Flattens a nested dictionary to `{ 'nav.items.agents': 'Agents', ... }`. */
function flatten(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  return Object.entries(value as object).reduce(
    (acc, [key, child]) => ({ ...acc, ...flatten(child, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}

const placeholders = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  const namespaces = Object.keys(resources.en) as (keyof typeof resources.en)[];

  it.each(namespaces)('namespace "%s": Persian has exactly the keys English has', (ns) => {
    expect(Object.keys(flatten(resources.fa[ns])).sort()).toEqual(
      Object.keys(flatten(resources.en[ns])).sort(),
    );
  });

  it.each(namespaces)(
    'namespace "%s": no message is empty and placeholders match between languages',
    (ns) => {
      const en = flatten(resources.en[ns]);
      const fa = flatten(resources.fa[ns]);
      for (const key of Object.keys(en)) {
        expect(en[key]!.trim(), `en ${ns}.${key}`).not.toBe('');
        expect(fa[key]!.trim(), `fa ${ns}.${key}`).not.toBe('');
        expect(placeholders(fa[key]!), `placeholders of ${ns}.${key}`).toEqual(placeholders(en[key]!));
      }
    },
  );

  it('every route title key resolves in every language', () => {
    const titleKeys: string[] = [];
    const walk = (list: typeof routes) =>
      list.forEach((route) => {
        if (isRouteHandle(route.handle)) titleKeys.push(route.handle.titleKey);
        if (route.children) walk(route.children);
      });
    walk(routes);
    expect(titleKeys.length).toBeGreaterThan(0);

    for (const locale of ['en', 'fa'] as const) {
      const i18n = createI18n(locale);
      for (const key of titleKeys) {
        expect(i18n.exists(key), `${locale}: ${key}`).toBe(true);
      }
    }
  });
});

describe('createI18n', () => {
  it('starts in the requested language, synchronously', () => {
    expect(createI18n('fa').t('shell:nav.items.overview')).toBe('نمای کلی');
    expect(createI18n('en').t('shell:nav.items.overview')).toBe('Overview');
  });

  it('interpolates values without HTML-escaping them (React escapes output)', () => {
    expect(createI18n('en').t('common:errors.reference', { id: 'a&b' })).toBe('Reference: a&b');
  });

  it('can switch language at runtime', async () => {
    const i18n = createI18n('en');
    await i18n.changeLanguage('fa');
    expect(i18n.t('common:actions.retry')).toBe('تلاش دوباره');
  });
});
