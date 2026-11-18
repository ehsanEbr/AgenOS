import { useIsMutating, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { asAuthMutation } from './auth-mutation';

/*
 * Authentication mutations whose input is a CREDENTIAL (a password): sign-in and sign-up.
 *
 * Why not simply pass the credentials as the mutation's variables. TanStack Query keeps `Mutation.state.variables` for as long as the
 * mutation is in the mutation cache (5 minutes by default, and never while something still observes it), and a mutation that is
 * waiting for connectivity holds them until it runs. Shortening that with `gcTime: 0` and `reset()` was tried and rejected: an
 * unobserved mutation that is still pending re-checks its own collection in a zero-delay loop (without end while it is paused
 * offline), and a `reset()` after an earlier call can detach a newer mutation.
 *
 * The design instead keeps the password out of the mutation cache altogether:
 *
 *   1. The caller's credentials go into a private ONE-SHOT HOLDER (`handoffs`), keyed by an opaque, non-secret TOKEN.
 *   2. The TOKEN is the mutation's only variable. It is all `Mutation.state.variables` ever contains.
 *   3. The mutation function takes the credentials out of the holder and DELETES the entry as its first statement, before anything is
 *      built or sent. From then on the credentials exist only as the arguments of the running request.
 *   4. Whatever happens, the entry is deleted again when the call ends, so a mutation that fails before its function runs cannot
 *      leave one behind.
 *
 * Offline: `networkMode: 'always'`. With the default ('online') a mutation is PAUSED when the browser is offline and its function does
 * not run until connectivity returns, which would leave the credentials in the holder indefinitely. With 'always' the function runs
 * promptly, the holder is emptied, and the browser's own network failure (mapped to the translated "cannot reach the server" message)
 * ends the request.
 *
 * ONE ACTIVE REQUEST per operation and query client (a "flight"). Two logins in flight at once could leave the browser holding the
 * cookie of one and the app showing the user of the other, so a second request is never started while one runs. What a second CALL
 * gets depends on who makes it:
 *
 *   - the SAME hook instance (a double submit of one form, in the same tick or later) receives the SAME promise: one request, one
 *     result, and the credentials of the repeated call are not stored;
 *   - ANY OTHER hook instance (another component, or a page that was left and opened again) is REJECTED with
 *     `CredentialOperationInProgressError`. It never receives another caller's result or error, and its credentials are neither
 *     stored nor sent. Sharing a result with a caller who typed something else would present someone else's outcome as its own.
 *
 * `isPending` is the state of the OPERATION in the mutation cache (a count of its pending mutations, which exposes no variables), not of
 * this instance's own mutation, so a page opened while another instance's request runs shows it as pending and blocks submission.
 * The rejection is the race-safe backstop for the moment before that state reaches the screen.
 *
 * The flight is registered before the mutation is started, so nothing that fails afterwards, even synchronously, can leave a flight
 * behind; and a call ends only the flight and the holder entry that it created itself.
 */

/** The error code of a call refused because another hook instance has this operation in flight. Stable: callers may match on it. */
export const CREDENTIAL_OPERATION_IN_PROGRESS = 'credential_operation_in_progress';

export class CredentialOperationInProgressError extends Error {
  readonly code = CREDENTIAL_OPERATION_IN_PROGRESS;
  constructor(readonly operation: string) {
    super(`A ${operation} request is already in progress`);
    this.name = 'CredentialOperationInProgressError';
  }
}

/** The only variable of a credential mutation: opaque, unique per call, and carrying nothing secret. */
interface HandoffToken {
  readonly operation: string;
}

const handoffs = new Map<HandoffToken, unknown>();

/** How many credential payloads are waiting to be taken by their mutation function. Zero whenever no call is between hand-over and start. */
export function pendingCredentialHandoffs(): number {
  return handoffs.size;
}

/** The one active request of an operation: who started it (a private per-hook-instance identity) and its promise. */
export interface CredentialFlight {
  readonly owner: object;
  readonly promise: Promise<unknown>;
}

const flights = new WeakMap<QueryClient, Map<string, CredentialFlight>>();

function flightsOf(client: QueryClient): Map<string, CredentialFlight> {
  let found = flights.get(client);
  if (!found) {
    found = new Map();
    flights.set(client, found);
  }
  return found;
}

/** Ends `flight` and nothing else: a flight registered later for the same operation is left alone. */
export function releaseFlight(
  active: Map<string, CredentialFlight>,
  operation: string,
  flight: CredentialFlight,
): void {
  if (active.get(operation) === flight) active.delete(operation);
}

/** A credential mutation. The hook exposes only `isPending` and `mutateAsync`: nothing of the mutation's own state, in particular no variables. */
export function useCredentialMutation<TCredentials, TData>(
  operation: string,
  send: (credentials: TCredentials) => Promise<TData>,
): { isPending: boolean; mutateAsync: (credentials: TCredentials) => Promise<TData> } {
  const client = useQueryClient();
  const [instance] = useState<object>(() => ({})); // this hook instance's private identity: not derived from anything the caller passes
  const mutationKey = ['credential', operation] as const;
  const mutation = useMutation(
    asAuthMutation({
      mutationKey,
      networkMode: 'always' as const,
      mutationFn: async (token: HandoffToken): Promise<TData> => {
        const credentials = handoffs.get(token) as TCredentials | undefined;
        handoffs.delete(token); // taken: from here on the holder no longer has them
        if (credentials === undefined) throw new Error('These credentials were already used');
        return send(credentials);
      },
    }),
  );
  const { mutateAsync } = mutation;
  // The operation's pending mutations in this client's cache (any instance's), as a count: no variables are read.
  const pending = useIsMutating({ mutationKey }, client) > 0;

  const run = useCallback(
    (credentials: TCredentials): Promise<TData> => {
      const active = flightsOf(client);
      const running = active.get(operation);
      if (running) {
        return running.owner === instance
          ? (running.promise as Promise<TData>)
          : Promise.reject(new CredentialOperationInProgressError(operation)); // nothing of this caller is stored
      }

      let settle!: { resolve: (value: TData) => void; reject: (reason: unknown) => void };
      const promise = new Promise<TData>((resolve, reject) => {
        settle = { resolve, reject };
      });
      const flight: CredentialFlight = { owner: instance, promise };
      const token: HandoffToken = Object.freeze({ operation });

      active.set(operation, flight); // registered BEFORE anything can start, so no failure below can leave a stale flight
      handoffs.set(token, credentials);
      const end = () => {
        handoffs.delete(token); // also covers a mutation that failed before its function ran
        releaseFlight(active, operation, flight); // this call's own flight only
      };
      try {
        void mutateAsync(token).then(
          (value) => {
            end(); // before the caller continues, so a retry from its continuation finds no flight
            settle.resolve(value);
          },
          (reason: unknown) => {
            end();
            settle.reject(reason);
          },
        );
      } catch (reason) {
        end(); // a failure while setting the mutation up
        settle.reject(reason);
      }
      return promise;
    },
    [client, operation, instance, mutateAsync],
  );

  return { isPending: pending, mutateAsync: run };
}
