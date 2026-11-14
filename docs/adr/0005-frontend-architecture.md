# ADR-0005: Frontend architecture, Ant Design 6 and internationalization

**Status:** Accepted
**Context:** The web app was a shell with hard-coded English text, no theme or direction handling, an API client that knew
about endpoints, and no rules for how future product areas (Agents, Models, MCP Gateway, Software Intelligence, Executions,
Observability, Settings) should be organized. This ADR records the decisions that shape every later UI phase. The operational
guide is [frontend.md](../architecture/frontend.md).

## Decisions

### 1. Layers and feature boundaries

`app` (composition: providers, router, shell) -> `features/<name>` (one folder per product area) -> `shared` (UI primitives,
API client, theme, i18n infrastructure, hooks). Arrows mean "may import".

- `shared/` knows nothing about `features/` or `app/`. `features/` never import `app/`. The app reaches a feature only
  through its public `index.ts`. Features do not import each other's internals and may not form cycles.
- Enforced by ESLint (`no-restricted-imports`) and `tools/check-module-boundaries.mjs` (run inside the web `lint` target), the
  same checker the API uses for its modules. Verified with planted violations.
- A feature's `index.ts` is its contract: routes (lazy), messages, and the few components/hooks other code may use.
- No global "components" or "services" folders: UI primitives are in `shared/ui`, HTTP in `shared/api` (client) and
  `features/<name>/api.ts` (endpoints). A shared component is created when a second consumer exists, not before.

### 2. The API client owns HTTP, features own endpoints

`shared/api/client.ts` (`apiRequest`) is the only code that calls `fetch` (ESLint-enforced). It validates every response against a
shared contract, applies a timeout (`VITE_API_TIMEOUT_MS`, default 15 s), supports cancellation, sends a correlation id, and
normalizes every failure to `ApiClientError` (`network | timeout | http | invalid_response`). A deliberate cancellation stays an
`AbortError`. Endpoint functions live in the feature that uses them (`features/health/api.ts`). UI shows localized text chosen by
an error _category_, never backend wording or status codes. Retry policy: at most two retries, only for network, timeout and
408/502/503/504; mutations never retry.

### 3. State

Server data: TanStack Query only. Client-only preferences (theme, language, sidebar): one persisted Zustand store in `app/state`.
Short-lived UI state (an open dialog): `useState` in the component. Server data is never copied into Zustand.

### 4. Routing

One route table (`app/router/routes.tsx`) using React Router data-router objects. Features export their routes from `index.ts`, with
pages loaded by `route.lazy` (route-level code splitting: confirmed in the build output). Route `handle` metadata carries the
title key. Two error boundaries: one around pages (inside the shell, so navigation survives a crashing page) and one at the root.
Authentication is not implemented; the table documents where a guard route is inserted, so adding one later does not change its shape.
`react-router` is imported directly (the `react-router-dom` re-export package is banned by lint), staying on v7.

### 5. Ant Design 6.7.0 (upgrade from 5.29.3), configured, not wrapped

**Decision: adopt Ant Design 6 now.**

- _Specification:_ it says only "Ant Design" and pins no version, so v6 does not deviate from it.
- _Why now:_ the design system, theme and RTL handling are built in this phase. Building them on v5 and migrating later costs
  more for every component added in between. The Phase 1.3 audit's spike showed the app compiled with no source changes; this
  phase confirms it with the full test suite, the production build and a real browser.
- _Compatibility checked:_ `antd` 6.7.0 requires React >= 18 (we use 19.3.1, no compatibility patch needed) and depends on
  `@ant-design/icons` ^6.3.4 (v6 icons are not compatible with antd 5, so they move together). The official migration guide lists
  no removed APIs in v6; deprecated props still work with warnings and are removed in v7. CSS variables are on by default.
- _Advantages:_ current major with active development; CSS-variable theming (used for the pre-paint script and global styles);
  the newer `classNames`/`styles` semantic API; avoiding a forced migration when v7 removes the v5 spellings.
- _Risks and mitigations:_ (1) v6 changed defaults in **minor** releases (overlay blur disabled in 6.3, size enum `default/middle` ->
  `medium` in 6.3.x), so `antd` and `@ant-design/icons` are **pinned to exact versions** and upgraded deliberately with the test suite
  and a visual check. (2) Internal DOM structure changed, so tests query by role/label, never by Ant Design class names (two
  intentional exceptions assert direction: `-rtl` modifier classes and the drawer placement). (3) The code already uses the v6
  spellings (`Alert title`, `notification title`, `Tag variant`, `Drawer size`), so it carries no deprecation warnings.
- _Bundle:_ the UI chunk is ~614 kB raw (~204 kB gzipped); with React and app code the initial download is ~430 kB gzipped,
  about 10% above Phase 1.1 (more components, i18n, router). No Ant Design 5 comparison was possible after the shell grew, so
  this is a measurement, not a claim of equal size.

We do **not** build a second UI framework: the design system is one file (`shared/theme/theme.ts`) mapping our decisions onto Ant Design
tokens, plus five small primitives (`Page`, `LoadingState`, `EmptyState`, `ErrorState`, `useNotify`) that every page needs.
Forms, tables, dialogs and drawers use Ant Design components directly; conventions are documented, not wrapped.

### 6. Theme, language and direction

- Theme mode `light | dark | system` (default `system`, follows the OS live). Direction is **derived from the language**
  (`en` LTR, `fa` RTL), so there is one layout and no mirrored copy; all custom CSS uses logical properties. Ant Design's
  `ConfigProvider` receives `direction`, `locale` and `theme` from a single `ThemeProvider`.
- Font stacks per language live in the locale registry (`shared/i18n/locales.ts`); system fonts only, so no font download is added.
  A webfont is a one-line change there plus an `@font-face`.
- `prefers-reduced-motion` turns Ant Design animation off.
- A small inline script in `index.html` applies the saved theme, language and direction **before first paint** (no flash of the
  wrong theme). A test ties its storage key and colors to the real store and Ant Design tokens so they cannot drift.

### 7. i18next + react-i18next (two new dependencies)

Persian and English must both work, and features need to add their own translations. i18next 27.1.1 and react-i18next 18.0.1 (exact
pins) provide namespaces per feature, interpolation and plurals, and typed keys through TypeScript module augmentation: a misspelled
key is a compile error and a Persian dictionary missing a key does not compile (`MessagesOf<typeof en>`). Dictionaries are bundled
for now and initialization is synchronous; lazy-loaded namespaces are a contained change in `create-i18n.ts` when dictionaries grow.
A tiny home-made `t()` was rejected: it would have to be replaced as soon as plurals, interpolation or lazy loading were needed.

### 8. Libraries deliberately NOT added

React Flow, Monaco Editor and ECharts (named in the specification) arrive in the phase whose feature needs them. No form library and no
table wrapper yet. No browser end-to-end framework: component and routing tests with Testing Library cover the behavior, and the one
thing jsdom cannot show (real layout, direction, painting) was verified once with a real browser during this phase, outside the repo.

## Dependency changes

| Package             | Before           | After              | Why                                                  |
| ------------------- | ---------------- | ------------------ | ---------------------------------------------------- |
| `antd`              | ^5.26.0 (5.29.3) | **6.7.0** (exact)  | Decision 5                                           |
| `@ant-design/icons` | ^5.6.0           | **6.3.4** (exact)  | Required pair for antd 6                             |
| `react-router-dom`  | ^7.6.0           | removed            | Replaced by `react-router`                           |
| `react-router`      | -                | **7.18.5** (exact) | The package React Router 7 recommends importing from |
| `i18next`           | -                | **27.1.1** (exact) | Decision 7                                           |
| `react-i18next`     | -                | **18.0.1** (exact) | Decision 7                                           |

React 19.3.1, TanStack Query 5.107.1, Zustand 5.1.0 and Zod 4.6.7 are unchanged.

## Consequences

- A new feature follows a checklist (frontend.md) and most violations fail `pnpm lint`.
- Adding a language is: one locale entry, one Ant Design locale, one dictionary per namespace; the compiler lists what is missing.
- Upgrading Ant Design is a deliberate task: bump both packages together, run the suite, and look at the app in a browser.
- The initial JavaScript is ~1.35 MB raw because Ant Design is imported eagerly by the shell. Reducing it is possible (finer
  chunking, lazy-loading heavy components) but was not done without evidence that it matters.
