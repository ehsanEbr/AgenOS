export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  readonly id: string;
  /** Lower-cased and trimmed. */
  readonly email: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
}

/**
 * Who is making a request. This is the ONLY thing authentication hands to the rest of the system (ADR-0010): a later OIDC sign-in
 * produces the same value from a different credential, and nothing downstream changes.
 */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
}
