import type { OrganizationWithRole } from '@agentos/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, organizationPage, testOrganization } from '../../test/fixtures/api';
import { SIGNED_IN, SIGNED_OUT, createTestQueryClient } from '../../test/render';
import { loadedOrganizations, organizationKeys, useOrganization, useOrganizationList } from './queries';

/*
 * The data layer of the organizations feature (hooks and keys). The screens that use it are tested through the real application in
 * `app/router/organization-routes.spec.tsx`.
 */

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number): OrganizationWithRole => ({
  ...testOrganization,
  id: idOf(n),
  name: `Organization ${n}`,
});

function signedIn() {
  const client = createTestQueryClient(SIGNED_IN);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe('organization query keys', () => {
  it('live under the private root "organizations", and a detail key contains the organization id', () => {
    expect(organizationKeys.all).toEqual(['organizations']);
    expect(organizationKeys.lists()[0]).toBe('organizations');
    expect(organizationKeys.detail('a')).toEqual(['organizations', 'detail', 'a']);
    expect(organizationKeys.detail('a')).not.toEqual(organizationKeys.detail('b'));
  });
});

describe('loadedOrganizations', () => {
  it("flattens the loaded pages in order and reports the server's total", () => {
    const data = {
      pages: [
        { items: [row(1), row(2)], page: { total: 5 } },
        { items: [row(3)], page: { total: 5 } },
      ],
    };
    expect(loadedOrganizations(data).organizations.map((o) => o.name)).toEqual([
      'Organization 1',
      'Organization 2',
      'Organization 3',
    ]);
    expect(loadedOrganizations(data).total).toBe(5);
  });

  it('is empty before anything is loaded', () => {
    expect(loadedOrganizations(undefined)).toEqual({ organizations: [], total: 0 });
  });
});

describe('useOrganizationList', () => {
  it("asks for the API's largest page and continues from the loaded offset", async () => {
    const spy = mockFetch(({ url }) => {
      const offset = Number(url.searchParams.get('offset'));
      return jsonResponse(organizationPage(offset === 0 ? [row(1), row(2)] : [row(3)], { offset, total: 3 }));
    });
    const { wrapper } = signedIn();
    const { result } = renderHook(() => useOrganizationList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(String(spy.mock.calls[0]![0])).toContain('limit=100&offset=0');
    expect(result.current.hasNextPage).toBe(true); // 2 loaded of 3

    await act(async () => void (await result.current.fetchNextPage()));
    expect(String(spy.mock.calls[1]![0])).toContain('limit=100&offset=2'); // the number of rows loaded, not a page multiple
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('stops when the server returns an empty page although its total says more (no endless "load more")', async () => {
    mockFetch(({ url }) =>
      jsonResponse(
        organizationPage(Number(url.searchParams.get('offset')) === 0 ? [row(1)] : [], {
          offset: Number(url.searchParams.get('offset')),
          total: 50,
        }),
      ),
    );
    const { wrapper } = signedIn();
    const { result } = renderHook(() => useOrganizationList(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true); // 1 of 50 loaded (this read also makes the hook re-render when it changes)
    await act(async () => void (await result.current.fetchNextPage()));
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('does not run while the session is not authenticated (the session gate holds for this feature too)', async () => {
    const spy = mockFetch(() => jsonResponse(organizationPage([row(1)])));
    const client = createTestQueryClient(SIGNED_OUT);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useOrganizationList({ enabled: true }), { wrapper }); // even with its own `enabled`

    await act(async () => void (await new Promise((done) => setTimeout(done, 20))));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(false);
  });
});

describe('useOrganization', () => {
  it('fetches one organization by id', async () => {
    const spy = mockFetch(() => jsonResponse(row(7)));
    const { wrapper } = signedIn();
    const { result } = renderHook(() => useOrganization(idOf(7)), { wrapper });

    await waitFor(() => expect(result.current.data?.name).toBe('Organization 7'));
    expect(String(spy.mock.calls[0]![0])).toMatch(new RegExp(`/organizations/${idOf(7)}$`));
    expect(result.current.valid).toBe(true);
  });

  it.each([[undefined], ['not-an-id'], [''], ['../../me'], ['<script>']])(
    'sends nothing for %j: it is not an id, so it is the same not-found a foreign id would be',
    async (value) => {
      const spy = mockFetch(() => jsonResponse(row(1)));
      const { wrapper } = signedIn();
      const { result } = renderHook(() => useOrganization(value), { wrapper });

      await act(async () => void (await new Promise((done) => setTimeout(done, 20))));
      expect(spy).not.toHaveBeenCalled();
      expect(result.current.valid).toBe(false);
    },
  );
});
