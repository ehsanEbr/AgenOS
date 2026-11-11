import { z } from 'zod';

/** Identifier for any persisted entity. Entities use UUIDs (spec section 6.1). */
export const idSchema = z.uuid();
export type Id = z.infer<typeof idSchema>;

/** UTC timestamp serialized as an ISO-8601 string on the wire. */
export const isoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
