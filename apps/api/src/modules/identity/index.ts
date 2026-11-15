// Public surface of the identity module (ADR-0010, decision 1). Everything not exported here is private to the module.
export { IdentityModule, identitySettings } from './identity.module';
export type { Principal } from './domain/user';
export { UserDirectory, type UserSummary } from './application/user-directory';
export { AuthenticationGuard } from './presentation/authentication.guard';
export { CurrentPrincipal, Public } from './presentation/decorators';
