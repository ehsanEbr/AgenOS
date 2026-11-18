import { isApiClientError } from '../../shared/api/errors';

/** `404`: for a project this is "does not exist, belongs to another organization, or you have no access": one answer for all three. */
export const isNotFound = (error: unknown): boolean => isApiClientError(error) && error.status === 404;

/** `403`: the caller can see the project but lacks the permission. For the read side this means "your access changed". */
export const isForbidden = (error: unknown): boolean => isApiClientError(error) && error.status === 403;
