import { randomBytes } from 'node:crypto';
import type { Person } from './stack-info';

/*
 * Setup that is not under test goes through the API (ADR-0012 D1); the behavior under test goes through the UI. Requests use bearer tokens
 * (`delivery: 'token'`), as the API-level system tests do, so they carry no cookie and never touch a browser context.
 */

export const PASSWORD = 'a long browser test password';

/** A short unique suffix, so every test names its own organization and projects and none depends on another. */
export const unique = () => randomBytes(3).toString('hex');

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export class Api {
  constructor(private readonly origin: string) {}

  async call<T = unknown>(
    path: string,
    { token, method, body }: { token?: string; method?: string; body?: unknown } = {},
  ): Promise<ApiResult<T>> {
    const response = await fetch(`${this.origin}/api/v1${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  }

  /** Registers an account and signs it in for a token. Registration is limited to 5 per hour per address: see `global-setup.ts`. */
  async register(name: string, email: string): Promise<Person> {
    const registered = await this.call<{ user: { id: string } }>('/auth/register', {
      body: { email, displayName: name, password: PASSWORD },
    });
    if (registered.status !== 201) throw new Error(`registering ${email} answered ${registered.status}`);
    const login = await this.call<{ token: string }>('/auth/login', {
      body: { email, password: PASSWORD, delivery: 'token' },
    });
    if (login.status !== 200) throw new Error(`signing ${email} in answered ${login.status}`);
    return { name, email, password: PASSWORD, id: registered.body.user.id, token: login.body.token };
  }

  async createOrganization(owner: Person, name: string): Promise<string> {
    const created = await this.call<{ id: string }>('/organizations', { token: owner.token, body: { name } });
    if (created.status !== 201) throw new Error(`creating organization "${name}" answered ${created.status}`);
    return created.body.id;
  }

  async addOrganizationMember(
    owner: Person,
    organizationId: string,
    person: Person,
    role: 'admin' | 'member' | 'viewer',
  ): Promise<void> {
    const added = await this.call(`/organizations/${organizationId}/members`, {
      token: owner.token,
      body: { email: person.email, role },
    });
    if (added.status !== 201)
      throw new Error(`adding ${person.email} to the organization answered ${added.status}`);
  }

  async createProject(
    creator: Person,
    organizationId: string,
    name: string,
    slug: string,
    description?: string,
  ): Promise<{ id: string; name: string; slug: string }> {
    const created = await this.call<{ id: string; name: string; slug: string }>('/projects', {
      token: creator.token,
      body: { organizationId, name, slug, ...(description === undefined ? {} : { description }) },
    });
    if (created.status !== 201) throw new Error(`creating project "${name}" answered ${created.status}`);
    return created.body;
  }

  async addProjectMember(
    admin: Person,
    projectId: string,
    person: Person,
    projectRole: 'project_admin' | 'project_member' | 'project_viewer',
  ): Promise<void> {
    const added = await this.call(`/projects/${projectId}/members`, {
      token: admin.token,
      body: { userId: person.id, projectRole },
    });
    if (added.status !== 201)
      throw new Error(`adding ${person.email} to the project answered ${added.status}`);
  }
}

/** A fresh organization owned by `owner`, with the given people as organization members, for a test that wants its own world. */
export async function newWorld(
  api: Api,
  owner: Person,
  members: { person: Person; role: 'admin' | 'member' | 'viewer' }[] = [],
): Promise<{ organizationId: string; organizationName: string; tag: string }> {
  const tag = unique();
  const organizationName = `Organization ${tag}`;
  const organizationId = await api.createOrganization(owner, organizationName);
  for (const { person, role } of members)
    await api.addOrganizationMember(owner, organizationId, person, role);
  return { organizationId, organizationName, tag };
}
