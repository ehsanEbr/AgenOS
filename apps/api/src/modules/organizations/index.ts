// Public surface of the organizations module (ADR-0010, decision 1). Everything not exported here is private to the module.
export { OrganizationsModule } from './organizations.module';
export { AuthorizationService } from './application/authorization.service';
export { MembershipDirectory } from './application/membership-directory';
export { TenantAccess } from './application/tenant-access';
export { OrganizationScope, scopeOf, type TenantContext } from './domain/tenant';
