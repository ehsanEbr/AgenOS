import { healthResponseSchema } from '@agentos/contracts';
import { apiRequest } from '../../shared/api/client';

/** GET /api/v1/health: liveness of the API process. The response is validated against the shared contract. */
export const getHealth = (signal?: AbortSignal) => apiRequest('/health', healthResponseSchema, { signal });
