/*
 * The one exemption from the mutation session gate (ADR-0012 D4, rule 5): authentication operations (sign-in, sign-up, sign-out)
 * must be able to run without an authenticated session, and nothing else may.
 *
 * The exemption is NOT a string flag a feature could write (`meta: { auth: true }` means nothing). It is the identity of a value that
 * only this module holds. The module is internal to `features/auth`: it is not exported from `features/auth/index.ts`, and the
 * existing boundary rules (ESLint for `app/`, `check-module-boundaries` for features) reject an import of it from anywhere else. So
 * only the auth feature can mark a mutation, and a private feature mutation cannot claim the exemption by setting metadata.
 *
 * Honest limit: this is a module boundary, not a security boundary against code that already runs in the page. Such code could read
 * the marker from the mutation cache. It protects against accidents and against changes that pass review, which is its purpose.
 */

/** A UNIQUE symbol. `Symbol.for` would put it in the global registry, where anyone could recreate it. */
const AUTH_MUTATION = Symbol('agentos.auth-mutation');

type MutationMeta = Record<string, unknown>;

/** Marks mutation options as an authentication operation. Use it for sign-in, sign-up and sign-out only. */
export function asAuthMutation<T extends object>(
  options: T & { meta?: MutationMeta },
): T & { meta: MutationMeta } {
  return { ...options, meta: { ...options.meta, auth: AUTH_MUTATION } };
}

/** Is this mutation's metadata the genuine marker? Anything else, `true` and look-alike symbols included, is not. */
export function isAuthMutationMeta(meta: MutationMeta | undefined): boolean {
  return meta?.auth === AUTH_MUTATION;
}
