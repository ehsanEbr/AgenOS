# Frontend architecture and conventions (Phase 1.4)

The rulebook for `apps/web`: React 19, Vite 7, Ant Design 6, React Router 7, TanStack Query 5, Zustand 5, i18next, Zod
contracts shared with the API. Rules marked **[enforced]** fail `pnpm lint`; the rest are conventions reviewers check.
Decisions and reasons: [ADR-0005](../adr/0005-frontend-architecture.md). The API this app talks to follows
[backend.md](backend.md) (error shape, pagination, correlation ids).

## 1. Directory structure

```text
apps/web/
├── index.html                      pre-paint theme/language script, favicon, entry
├── public/                         static files served as-is (favicon.svg)
└── src/
    ├── main.tsx                    mounts <App/>, imports global.css
    ├── app/                        COMPOSITION: wires things together, contains no product logic
    │   ├── App.tsx                 providers + router
    │   ├── providers/              AppProviders, ThemeProvider (theme/locale/direction), I18nProvider, query-client.ts
    │   ├── router/                 routes.tsx (THE route table), create-router.ts, NotFoundPage, RouteErrorPage
    │   ├── layouts/                AppShell (sidebar/drawer + header + <main>), navigation.tsx, SidebarNav, PreferenceControls ...
    │   ├── state/                  ui-preferences.store.ts (Zustand: theme, language, sidebar)
    │   └── i18n/                   shell messages, resources.ts (all namespaces), create-i18n.ts, typed-keys declaration
    ├── features/<name>/            ONE FOLDER PER PRODUCT AREA (today: home, health)
    │   ├── index.ts                PUBLIC INTERFACE: routes, messages, the few components/hooks others may use
    │   ├── api.ts                  endpoint functions (apiRequest + contract schema)
    │   ├── queries.ts              query keys + TanStack Query hooks
    │   ├── i18n.ts                 this feature's messages (en + fa)
    │   ├── pages/  components/     only the folders the feature needs
    │   └── *.spec.tsx              tests next to the code
    ├── shared/                     BOTTOM LAYER: knows nothing about features or app
    │   ├── api/                    client.ts (apiRequest), errors.ts (ApiClientError, categories, retry policy)
    │   ├── config/env.ts           the ONLY reader of import.meta.env
    │   ├── i18n/                   locale registry (direction, font), Ant Design locales, common messages, types
    │   ├── theme/theme.ts          design tokens -> Ant Design theme
    │   ├── routing/                RouteHandle type
    │   ├── hooks/                  hooks with 2+ users (useMediaQuery)
    │   ├── ui/                     Page, states (Loading/Empty/Error), ErrorBoundary, useNotify
    │   └── styles/global.css       the little CSS Ant Design cannot provide
    └── test/                       setup, render helpers, media mock, API fixtures
```

Folders are created when something needs them. There is no global `components/`, `services/`, `utils/` or `types/` bucket.

## 2. Layers, ownership and dependency rules

```text
app ──► features/<name> ──► shared          (arrows: "may import")
 └──────────────────────────► shared
```

| Rule                                                                                                  | Enforcement                                                            |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `shared/` never imports `features/` or `app/`                                                         | **[enforced]** ESLint                                                  |
| `features/` never import `app/`                                                                       | **[enforced]** ESLint                                                  |
| `app/` imports a feature only through its public `features/<name>` (`index.ts`), never its internals  | **[enforced]** ESLint                                                  |
| A feature never imports another feature's internals; no cycles between features                       | **[enforced]** `tools/check-module-boundaries.mjs` (inside web `lint`) |
| No `fetch` outside `shared/api/client.ts`; no `import.meta.env` outside `shared/config/env.ts`        | **[enforced]** ESLint                                                  |
| No Prisma/ioredis/pg/bullmq; no `@agentos/api` or other apps; contracts are the only workspace import | **[enforced]** ESLint + Nx tags                                        |
| `react-router` (not `react-router-dom`)                                                               | **[enforced]** ESLint                                                  |
| `packages/contracts` stays framework-free (no React, no Ant Design)                                   | **[enforced]** ESLint                                                  |
| A shared component exists only when a second consumer exists                                          | convention                                                             |

**Ownership.** A feature owns its routes, pages, components, hooks, queries, API functions, messages and tests. `shared/` is owned by
everyone, which is why it must stay small and generic. `app/` owns composition: which providers exist, the route table, the shell.

**Public interface.** `features/<name>/index.ts` exports what the rest of the app may use: usually `<name>Routes` and `<name>Messages`,
sometimes a component or hook (the health feature exports `ApiStatus` for the shell header). Everything else is private.

**Cross-feature communication**, in order of preference:

1. _Composition in `app/` or a route._ The shell/route table puts features side by side; features do not need to know each other.
2. _Through the URL._ Navigate to another feature's route; pass identifiers in the path or query string.
3. _Through server state._ Both features read the same data through their own queries; invalidate by query key after a mutation.
4. _A feature's public export._ If feature B truly needs feature A's component or hook, import it from `features/a` (the index). If A and B
   need each other, the shared concept belongs in `shared/` or a third feature.
   Never share Zustand state between features; if two features need the same client state, it is application state and belongs in `app/state`.

## 3. Routing

**One route table** (`app/router/routes.tsx`); features contribute `RouteObject[]` from their `index.ts`:

```tsx
// features/agents/index.ts
export const agentsRoutes: RouteObject[] = [
  {
    path: 'agents',
    handle: { titleKey: 'agents:title' } satisfies RouteHandle,
    lazy: async () => ({ Component: (await import('./pages/AgentsPage')).AgentsPage }),
  },
  {
    path: 'agents/:agentId',
    handle: { titleKey: 'agents:detail.title' } satisfies RouteHandle,
    lazy: async () => ({ Component: (await import('./pages/AgentPage')).AgentPage }),
  },
];
// app/router/routes.tsx  (children of the page-level group)
children: [...homeRoutes, ...agentsRoutes, { path: '*', element: <NotFoundPage />, handle: notFoundHandle }];
```

- **Lazy loading:** pages load with `lazy: () => import(...)`, so each page is its own chunk (the build output shows `HomePage-*.js`).
  The feature's `index.ts` is eager and must stay tiny: routes, messages and small exports only, never page code.
- **Layouts and nesting:** `/` renders `AppShell` (persistent layout) with an `<Outlet/>`. Nested layouts (a detail page with tabs) are
  further nested routes with their own `element` containing an `<Outlet/>`.
- **Route metadata:** `handle.titleKey` is the page title (`namespace:key`). The shell sets `document.title`
  (`"<page> · AgentOS"`) and moves focus to `<main>` after each navigation. A test fails if a route's title key is missing in any language.
- **Errors:** `errorElement` on the page-level group renders `RouteErrorPage` _inside_ the shell, so a crashing page leaves navigation
  usable; the root route's `errorElement` covers a crashing shell. A failed lazy chunk takes the same path (retry = reload).
- **Not found:** the final `*` route renders `NotFoundPage` inside the shell with a localized title.
- **Navigation state:** while a lazy route loads, `NavigationProgress` shows a thin progress bar; the first load shows the router's
  `HydrateFallback` (a loading state) until the first page chunk arrives.
- **Navigation entries:** `app/layouts/navigation.tsx` lists the product areas. `status: 'available'` entries are links and need a real route;
  `'planned'` entries render disabled with a "Soon" tag. A test fails if an available entry has no route, or a planned one already has a page.
  When a feature lands: add its routes and flip the status.
- **Authentication later:** insert a pathless route between the shell's children and the feature routes, for example
  `{ element: <RequireAuth />, children: [...featureRoutes] }` (a component rendering `<Outlet/>` or redirecting, or a `loader` that
  throws a redirect). Public pages such as sign-in stay outside it. The table's shape does not change. Not implemented yet.

## 4. Design system and themes

**One file decides the visual language:** `shared/theme/theme.ts` maps our tokens onto Ant Design (no custom component library).

| Concern        | Where / how                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Color          | seed tokens `colorPrimary/Info/Success/Warning/Error`; Ant Design derives every shade, state and the dark palette |
| Radii, borders | `borderRadius` 8, `lineWidth` 1 (SM/LG radii derive from it)                                                      |
| Typography     | `fontSize` 14; font family per language from `shared/i18n/locales.ts`                                             |
| Spacing        | Ant Design's 4 px grid (`sizeUnit`/`sizeStep`); use `token.padding*`, `token.margin*`, or `<Flex gap>`            |
| Elevation      | `boxShadow` (cards, inline) and `boxShadowSecondary` (menus, popovers, drawers), stronger in dark                 |
| Motion         | on, unless the OS asks for reduced motion                                                                         |
| Shell colors   | Layout tokens follow light/dark (Ant Design's default navy sider/header is overridden)                            |

**Using tokens:**

```tsx
const { token } = theme.useToken(); // in components
<div style={{ padding: token.paddingLG, borderRadius: token.borderRadius }} />;
```

```css
/* in a stylesheet: only the few --app-* variables set by ThemeProvider, or Ant Design's own --ant-* variables */
.panel {
  background: var(--app-bg);
  border-radius: var(--app-radius);
  padding-inline: 16px;
}
```

Do not hard-code colors or pixel values that a token already defines. Do not restyle Ant Design components that already look right;
if every use of a component needs the same override, change the theme (a `components.<Name>` token or `ConfigProvider` default), not each call site.

**Light, dark, system.** `themeMode` in the preferences store: `light`, `dark`, or `system` (default, follows the OS live). `ThemeProvider`
selects the Ant Design algorithm, sets `data-theme` and `color-scheme` on `<html>` (so native controls and scrollbars follow), and exposes
`--app-bg/--app-text/--app-primary/--app-radius/--app-font-family`. A script in `index.html` applies the saved choice before first paint.

**State conventions** (use these components so every page behaves the same):

| State            | Use                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Page frame       | `<Page title description extra>`: one `<h1>`, consistent spacing; every page uses it                         |
| Loading          | `<LoadingState/>` (polite live region); not an unlabeled spinner                                             |
| Empty            | `<EmptyState description action/>`: say what is empty and what to do next                                    |
| Error (query)    | `<ErrorState error onRetry variant="inline"                                                                  | "page"/>`: localized by category, shows the support reference |
| Error (mutation) | `useNotify().error(error)`; query failures render in place, mutation failures notify                         |
| Disabled         | Ant Design's `disabled`; explain why with `title`/helper text when it is not obvious (nav "Soon" entries do) |
| Success          | `useNotify().success(...)`                                                                                   |

## 5. Language, direction (RTL/LTR) and fonts

- **Registry:** `shared/i18n/locales.ts` defines each language's `dir`, `lang` tag, native name and font stack: `en` (LTR) and `fa` (RTL).
  **Direction is derived from the language**, so there is exactly one layout. `ThemeProvider` passes `direction`, the Ant Design locale and the
  theme to `ConfigProvider`, and sets `<html lang dir>`. Components never pass `direction` themselves.
- **Switching** (header selects) re-renders the same React tree: DOM nodes are reused, nothing is duplicated. The choice persists; with
  none saved, the browser's language list decides (a Persian browser starts in Persian/RTL).
- **CSS rules:** only logical properties: `margin-inline-start`, `padding-inline`, `inset-inline-end`, `border-inline-start`, `text-align: start`,
  `block-size`/`inline-size`, never `left/right/margin-left/padding-right/width` for layout meaning. Prefer Ant Design layout components
  (`Flex`, `Space`, `Layout`), which already mirror. In style objects use the camelCase logical names (`paddingInline`, `insetInlineStart`).
- **Icons:** directional icons (arrows, chevrons, "back") must mirror; use Ant Design's direction-aware ones or `transform: scaleX(-1)` under
  `[dir=rtl]`. Do not mirror logos, media controls, numerals or clocks.
- **Numbers and dates:** format with `Intl` using the active language (`new Intl.NumberFormat(htmlLang)`), never by string concatenation.
- **Fonts:** system stacks per language (Vazirmatn first for Persian when installed, then Segoe UI/Tahoma/Noto Sans Arabic). To ship a webfont,
  add an `@font-face` (or a `@fontsource` import) and put its family first in that language's stack. Nothing else changes.
- **Verified in a real browser** during this phase (not just jsdom): sidebar, header controls and drawer mirror; Persian font stack applies;
  no horizontal overflow at 390 px in either direction; no flash of the wrong theme/direction on load.

### Adding text and languages

```ts
// features/agents/i18n.ts
const en = {
  title: 'Agents',
  empty: 'No agents yet',
  count_one: '{{count}} agent',
  count_other: '{{count}} agents',
};
export const agentsMessages: Messages<typeof en> = {
  en,
  fa: {
    title: 'عامل‌ها',
    empty: 'هنوز عاملی وجود ندارد',
    count_one: '{{count}} عامل',
    count_other: '{{count}} عامل',
  },
};
```

Add one line per language in `app/i18n/resources.ts`. Then `const { t } = useTranslation('agents'); t('empty')`. Keys are type-checked; the Persian
dictionary must have every English key (compile error otherwise) and a test checks placeholders match. UI text is never hard-coded in JSX.
To add a language: a `LOCALES` entry, an Ant Design locale in `shared/i18n/antd-locales.ts`, and a dictionary per namespace; the compiler lists what is missing.

## 6. API client and contracts

All HTTP goes through `apiRequest(path, schema, options)` (`shared/api/client.ts`). Endpoints live in the feature:

```ts
// features/agents/api.ts
import { agentSchema, paginatedSchema } from '@agentos/contracts';
export const listAgents = (
  query: { limit?: number; offset?: number; sort?: string; status?: string[] },
  signal?: AbortSignal,
) => apiRequest('/agents', paginatedSchema(agentSchema), { query, signal });
```

- **Contracts, not copies.** Request/response shapes come from `@agentos/contracts`. The response is validated; a mismatch becomes an
  `invalid_response` error, so components can trust their types. Never redefine a backend DTO in the frontend.
- **Base URL and timeout** come from the validated environment (`VITE_API_BASE_URL`, default `/api/v1`; `VITE_API_TIMEOUT_MS`, default 15000). Never hard-code URLs.
- **Query strings** follow the API conventions: `query: { limit, offset, sort: '-createdAt', status: ['a','b'] }` (arrays repeat the key; `undefined` is skipped).
- **Cancellation:** pass TanStack Query's `signal`; unmounting cancels the request, and a cancelled request is an `AbortError` that is not
  reported. A request cancelled before it starts never reaches the network.
- **Correlation:** every request carries a new `x-correlation-id`; failures expose `error.correlationId` (the server's id when it answered,
  otherwise the one we sent). `ErrorState` and `useNotify` show it as a support reference; it matches the API's logs.
- **Errors** are always `ApiClientError { kind, status, code, correlationId, details }`. UI never reads `status` or backend `message`:
  use `categorizeError(error)` (done for you by `ErrorState`/`useNotify`) to get a localized message, and `error.code` only to branch on
  a specific domain case (`if (error.code === 'agent_name_taken')`). `error.details` carries per-field validation issues for forms.

## 7. Server state (TanStack Query) and client state (Zustand)

| Question                                                                             | Tool                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Does it come from the API (or should be refetched/cached/invalidated)?               | **TanStack Query**: never copy it into Zustand or `useState` |
| Is it a preference of this browser that survives reloads (theme, language, sidebar)? | **Zustand** (`app/state`, persisted)                         |
| Is it short-lived and local (dialog open, input text, selected tab)?                 | **`useState`** in the component                              |
| Is it derived from the above?                                                        | compute it during render; do not store it                    |

**Query conventions**

```ts
// features/agents/queries.ts
export const agentKeys = {
  all: ['agents'] as const,
  list: (filters: object) => [...agentKeys.all, 'list', filters] as const,
  detail: (id: string) => [...agentKeys.all, 'detail', id] as const,
};
export const useAgents = (filters: ListFilters) =>
  useQuery({
    queryKey: agentKeys.list(filters),
    queryFn: ({ signal }) => listAgents(filters, signal),
    placeholderData: keepPreviousData,
  });

export function useCreateAgent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createAgent,
    onSuccess: () => client.invalidateQueries({ queryKey: agentKeys.all }), // general key invalidates lists and details
  });
}
```

- Keys are built by a per-feature key factory, general to specific. Components call hooks, never `useQuery` inline and never an API function directly.
- Defaults (`app/providers/query-client.ts`): `staleTime` 30 s; queries retry at most twice with backoff and **only** for network, timeout and
  408/502/503/504; 4xx, `invalid_response` and cancellations never retry; **mutations never retry**. Override per query only with a reason.
- Render from the query state: `isPending` -> `LoadingState`, `isError` -> `ErrorState error={error} onRetry={refetch}`, empty data -> `EmptyState`.

**Zustand conventions** (`app/state/ui-preferences.store.ts` is the reference): read with selectors
(`useUiPreferences((s) => s.themeMode)`) so components re-render only for what they use; persist only genuine preferences; validate stored data
(invalid fields fall back individually) and tolerate unavailable storage. Add a new store only for genuine client-side application state.

## 8. Components, hooks, forms, tables, dialogs, notifications

- **Shared UI** (`shared/ui`) is generic and has no knowledge of products: `Page`, states, `ErrorBoundary`, `useNotify`. Add one when a second
  consumer appears. **Feature components** live in the feature, take plain props, and call the feature's hooks. **Layout components** are in `app/layouts`.
- **Keep components small.** A page orchestrates (hooks + layout); extract a component when a block has its own state or is reused. Pass data down
  one or two levels; beyond that, let the child call the feature's query hook (TanStack Query de-duplicates) instead of drilling props.
- **Hooks:** feature hooks in `queries.ts`/`hooks.ts` inside the feature; a hook goes to `shared/hooks` only with 2+ users in different features.
- **Utilities:** a function used by one feature stays in it. No catch-all `utils.ts`.
- **Forms:** Ant Design `Form`. Validate with the **contract schema** on submit (`schema.safeParse(values)` and map `issues` to `form.setFields`),
  so client and server rules cannot diverge; map the API's `validation_error` `details` the same way. Disable submit while the mutation `isPending`.
  A small helper is added when the first form lands, not before.
- **Tables:** Ant Design `Table` with **server-side** pagination and sorting: `pagination.current/pageSize` <-> `offset/limit`, `sorter` <-> `sort=-field`,
  `total` from `page.total`; `loading` from the query; `EmptyState` for no rows. Always set `rowKey` to the entity id (never the array index).
- **Dialogs and drawers:** Ant Design `Modal`/`Drawer`, open state in `useState`, content is a feature component so it unmounts when closed
  (`destroyOnHidden`). Modal = a decision or short form; Drawer = detail/edit alongside the page. Both manage focus; give them a title.
- **Notifications:** `useNotify()` only (context-aware: follows theme, language and direction). Never the static `message.xxx()`/`notification.xxx()` calls.

## 9. Testing strategy

Stack: Vitest 3 + jsdom + Testing Library. Run `pnpm test` (all projects) or `pnpm exec nx test @agentos/web`.

| Level               | What                                                                                                           | Example                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Unit**            | pure logic: error categories, retry policy, locale detection, theme resolution, env parsing, store persistence | `shared/api/errors.spec.ts`, `app/state/ui-preferences.store.spec.ts`   |
| **API client**      | success + contract validation, correlation headers, query strings, every failure kind, timeout, cancellation   | `shared/api/client.spec.ts`                                             |
| **Component**       | a component in the real providers: roles, text, behavior                                                       | `shared/ui/ui.spec.tsx`                                                 |
| **Hook**            | query hooks with `renderHook` + the real retry policy (instant backoff)                                        | `features/health/health.spec.tsx`, `app/providers/query-client.spec.ts` |
| **Routing**         | the real route table: lazy pages, not-found, error boundary, title, focus, nav consistency                     | `app/app-shell.spec.tsx`, `app/router/routes.spec.ts`                   |
| **Theme/direction** | light/dark/system/reduced motion; en LTR vs fa RTL; live switching without remounting                          | `app/providers/ThemeProvider.spec.tsx`                                  |
| **Translations**    | every language has every key, placeholders match, route titles resolve                                         | `app/i18n/resources.spec.ts`                                            |

Helpers (`src/test`):

- `renderWithProviders(ui, { preferences })` mounts a component in the real theme/i18n/query providers; `renderApp('/path', { preferences })` mounts the whole
  app (shell + route table) at a URL. `createTestQueryClient()` is the real client with instant retries.
- `mockFetch(handler)` replaces `fetch`; `healthyApi()` answers the health endpoint. Fixtures in `test/fixtures/api.ts` are typed with the shared contracts
  (a contract change breaks the fixture at compile time) and look like real API payloads (UUIDs, the standard error body, a correlation id).
- `setViewportWidth(500)`, `setSystemDarkMode(true)`, `setReducedMotion(true)` (`test/media.ts`) change the simulated device and notify subscribers.
- Preferences and `localStorage` reset before every test; tests start as an English, light-theme, desktop visitor.

Conventions: query by **role and accessible name** (`getByRole('navigation', { name: 'Main navigation' })`), then text; never by Ant Design class names or
DOM structure (the only exceptions assert direction: `-rtl` modifiers, drawer placement). Test behavior a user or screen reader can perceive, not
implementation (no asserting on hook internals or re-render counts). Use `findBy*`/`waitFor` for async UI, not fixed sleeps. Each feature tests: its states
(loading/empty/error/success), its hooks' retry behavior if it is non-default, and its route. No browser end-to-end framework is used (ADR-0005).

## 10. Performance and accessibility

- **Code splitting:** route-level via `route.lazy` (verified in the build: `HomePage-*.js` is its own 1.5 kB chunk). Vendor code is split by package family
  (`react`, `antd`) so it caches independently. Initial JavaScript is about 1.35 MB raw / 430 kB gzipped, dominated by Ant Design.
  Do not optimize further without measurement; the likely levers are lazy-loading heavy components and, later, heavy libraries (editor, charts, flow canvas)
  inside their features' lazy routes.
- **Re-renders:** read Zustand with selectors; keep query hooks near their consumers; do not add `memo`/`useMemo` without a measured problem
  (the few `useMemo`s in the providers protect a context value/theme object from changing identity). Always use stable keys (`key={item.id}`), never indexes for dynamic lists.
- **Accessibility built in:** semantic landmarks (`header`, `aside`, `nav` with a label, `main`), a skip link as the first Tab stop, `aria-current="page"` on the active
  link, one `<h1>` per page, labeled controls (`aria-label` on selects/icon buttons), live regions for loading and status, document title and focus management on
  navigation, `lang` per language option, `prefers-reduced-motion` respected, native `color-scheme`. Keyboard: Tab order follows reading order; Ant Design
  menus/selects/drawers handle arrow keys, Escape and focus trapping.
- **Responsive:** at `>= 992 px` (Ant Design `lg`) a collapsible sidebar; below it the same navigation in a drawer opened from the header. The breakpoint read is
  synchronous on first render, so the layout does not flash.
- Not yet done: automated accessibility auditing (axe) and contrast checks of the custom palette in CI; Lighthouse-style performance budgets.

## 11. How to add a new feature

1. **Contracts first** (if it talks to the API): add Zod schemas in `packages/contracts/src/<feature>.ts` and export them.
2. **Create `features/<name>/`** with only what you need: `index.ts`, `api.ts`, `queries.ts`, `i18n.ts`, `pages/`, `components/`.
3. **API functions** in `api.ts` using `apiRequest` + contract schemas (accept `signal`). **Query keys + hooks** in `queries.ts` (key factory, `useX`, `useCreateX` with invalidation).
4. **Messages** in `i18n.ts` (`Messages<typeof en>`: English and Persian). Add the namespace to `app/i18n/resources.ts`.
5. **Pages** with `<Page>` and the state components. Load them lazily from the route objects you export in `index.ts`, each with `handle.titleKey`.
6. **Register**: spread `<name>Routes` into `app/router/routes.tsx`; if it has a nav entry, flip its `status` to `available` in `app/layouts/navigation.tsx`.
7. **Tests** next to the code: states, hooks (retry behavior), route (renders in the app at its URL, in both languages if it has text).
8. **Run** `pnpm lint` (layers, cycles, fetch/env rules), `pnpm test`, `pnpm build`; open the app in light/dark and English/Persian.

Reviewer checklist: public surface only via `index.ts`; no `fetch`/`import.meta.env`; contract types at the boundary; every string translated; logical CSS only; states
(loading/empty/error) handled with the shared components; roles/labels for tests; no server data in Zustand; no new shared component without a second consumer.

## 12. Known limitations

- **No automated test of real layout.** jsdom cannot show layout, painting or font rendering. RTL/dark/responsive behavior was verified once in real Chrome (computed
  positions, screenshots, keyboard) with a throwaway script outside the repo; there is no browser test in CI by design (ADR-0005). Regressions in visual layout would not be caught automatically.
- **Only Chrome was used for that check;** Firefox and Safari were not exercised (Ant Design 6 and the CSS used target current evergreen browsers).
- **Persian translations were written for this phase's few strings** and have not been reviewed by a native-speaking editor; terminology (for example "MCP Gateway") should be reviewed before release.
- **No webfont is bundled:** Persian uses the first installed of Vazirmatn/Segoe UI/Tahoma/Noto Sans Arabic. Rendering therefore differs by operating system until a font is shipped.
- **Dictionaries are bundled** into the main chunk (small today, not measured separately). Lazy-loading per-namespace dictionaries will be needed when feature text grows.
- **Authentication, authorization guards, forms and tables are conventions only**; nothing in the repo implements them yet. The conventions have not been exercised by a real feature.
- **Directional icons and RTL date/number formatting** are documented rules; no feature uses them yet, so they are untested.
- **The initial bundle (~430 kB gzipped) is dominated by Ant Design**; no budget or analysis tooling is wired into CI.
- **Contrast of the custom palette** (indigo primary, status colors) was chosen for accessibility but not measured with a tool.
