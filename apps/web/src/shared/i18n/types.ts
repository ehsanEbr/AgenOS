/**
 * The shape of a message dictionary with every leaf typed as `string`. A translation declared as
 * `const fa: MessagesOf<typeof en>` fails to compile when it lacks a key that the English source has.
 */
export type MessagesOf<T> = { [K in keyof T]: T[K] extends string ? string : MessagesOf<T[K]> };

/** A namespace's dictionaries, one per supported locale. Features export one of these from their `index.ts`. */
export interface Messages<T> {
  en: T;
  fa: MessagesOf<T>;
}
