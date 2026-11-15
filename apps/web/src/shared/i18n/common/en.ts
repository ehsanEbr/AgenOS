/** Namespace `common`: strings used by shared UI components (states, errors, generic actions). */
export const commonEn = {
  actions: {
    retry: 'Try again',
    goHome: 'Back to overview',
  },
  states: {
    loading: 'Loading',
  },
  errors: {
    title: 'Something went wrong',
    reference: 'Reference: {{id}}',
    network: 'Cannot reach the server. Check your connection and try again.',
    timeout: 'The server took too long to respond. Try again.',
    invalid_response: 'The server sent a response this app could not understand.',
    validation: 'Some of the information is not valid.',
    unauthenticated: 'You need to sign in to continue.',
    forbidden: 'You do not have permission to do this.',
    not_found: 'The requested item could not be found.',
    conflict: 'This conflicts with the current state. Refresh and try again.',
    rate_limited: 'Too many requests. Wait a moment and try again.',
    unavailable: 'The service is temporarily unavailable. Try again shortly.',
    server: 'The server hit an unexpected problem.',
    unknown: 'An unexpected error occurred.',
  },
  notFound: {
    title: 'Page not found',
    description: 'The page you are looking for does not exist or has moved.',
  },
  boundary: {
    description: 'The page hit an unexpected error.',
  },
};
