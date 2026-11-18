import type { Project, ProjectMember } from '@agentos/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  healthOk,
  jsonResponse,
  mockFetch,
  testOrganization,
  testProject,
  testProjectMember,
  testUser,
} from '../../test/fixtures/api';
import { renderWithProviders } from '../../test/render';
import { AddMemberModal } from './AddMemberModal';
import { ChangeMemberRoleModal } from './ChangeMemberRoleModal';
import { RemoveMemberModal } from './RemoveMemberModal';

/*
 * What each member dialog tells Ant Design's `Modal` while its request is running.
 *
 * The dialogs must not be dismissable while a request runs (Cancel, the close button, Escape, a click on the mask). Cancel and the close
 * button are checked through the screen in `app/router/project-members-writes.spec.tsx`. ESCAPE cannot be checked that way here: under
 * jsdom Ant Design gives every dialog the same id (its `useId` returns the constant "test-id" when NODE_ENV is "test"), and the portal keeps
 * its Escape stack keyed by that id, so an Escape event does not reach the dialog even when `keyboard` is on (verified: the dialog survives
 * an Escape with `keyboard` forced to true). A test that pressed Escape could therefore never fail. So the contract is checked at its
 * source instead: the props the dialog passes to `Modal`, which are exactly what Ant Design acts on in a browser.
 * A real-browser check of Escape belongs to the browser suite (ADR-0012 step 7).
 */

const modalProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('antd', async (importOriginal) => {
  const antd = await importOriginal<typeof import('antd')>();
  const React = await import('react');
  const Recording = Object.assign((props: Record<string, unknown>) => {
    modalProps.push(props);
    return React.createElement(antd.Modal, props as never);
  }, antd.Modal);
  return { ...antd, Modal: Recording };
});

const project: Project = { ...testProject, projectRole: 'project_admin' };
const member: ProjectMember = {
  userId: '20000000-0000-4000-8000-000000000001',
  email: 'member1@example.com',
  displayName: 'Member 1',
  role: 'project_member',
  joinedAt: testProject.createdAt,
};
const lastProps = () => modalProps.at(-1)!;

/** The fetch fake: the dialogs' reads answer at once, the one write is held until the test lets it go. */
function fakeApi() {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => (release = resolve));
  const spy = mockFetch(({ url, init }) => {
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (path === '/health') return jsonResponse(healthOk);
    if (path === `/organizations/${testOrganization.id}/members`)
      return jsonResponse({
        items: [{ ...member, role: 'member' }],
        page: { limit: 100, offset: 0, total: 1 },
      });
    if ((init.method ?? 'GET') === 'GET')
      return jsonResponse({ items: [], page: { limit: 100, offset: 0, total: 0 } });
    return held;
  });
  const writes = () =>
    spy.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET');
  return { release, writes };
}

const cases: { name: string; ui: () => ReactElement; start: () => Promise<void>; finish: Response }[] = [
  {
    name: 'adding a member',
    ui: () => <AddMemberModal project={project} open onClose={() => undefined} callerId={testUser.id} />,
    start: async () => {
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(await dialog.findByRole('radio', { name: /^Member 1 \(/ }));
      fireEvent.click(dialog.getByRole('button', { name: /Add member/ }));
    },
    finish: jsonResponse(member, 201),
  },
  {
    name: 'changing a role',
    ui: () => (
      <ChangeMemberRoleModal
        project={project}
        member={member}
        onClose={() => undefined}
        callerId={testUser.id}
      />
    ),
    start: async () => {
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(dialog.getByRole('radio', { name: 'Project viewer' }));
      fireEvent.click(dialog.getByRole('button', { name: 'Save role' }));
    },
    finish: jsonResponse({ ...member, role: 'project_viewer' }),
  },
  {
    name: 'removing a member',
    ui: () => (
      <RemoveMemberModal
        project={project}
        member={{ ...testProjectMember, userId: member.userId }}
        callerId={testUser.id}
        callerKeepsAccess
        onClose={() => undefined}
      />
    ),
    start: async () => {
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(dialog.getByRole('button', { name: 'Remove member' }));
    },
    finish: new Response(null, { status: 204 }),
  },
];

describe('a member dialog while its request runs', () => {
  it.each(cases)(
    '$name: the dialog cannot be dismissed by Escape, the close button, the mask or Cancel',
    async ({ ui, start, finish }) => {
      const api = fakeApi();
      modalProps.length = 0;
      renderWithProviders(ui());
      await screen.findByRole('dialog');

      // Idle: the dialog can be dismissed in every way.
      expect(lastProps()).toMatchObject({ keyboard: true, closable: true });
      expect(lastProps().cancelButtonProps).toMatchObject({ disabled: false });

      await start();
      await waitFor(() => expect(api.writes()).toHaveLength(1));
      await waitFor(() => expect(lastProps()).toMatchObject({ keyboard: false, closable: false }));

      // Running: Escape (`keyboard`), the close button (`closable`), the mask and Cancel are all disabled.
      expect(lastProps()).toMatchObject({ keyboard: false, closable: false, maskClosable: false });
      expect(lastProps().cancelButtonProps).toMatchObject({ disabled: true });

      api.release(finish);
      await act(async () => {
        await new Promise((done) => setTimeout(done, 20));
      });
    },
  );
});
