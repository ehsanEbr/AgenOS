// Public surface of the projects module (ADR-0011, decision 1). Everything not exported here is private to the module.
// ADR-0010 decided that `ProjectAccess` becomes public when its first consumer (Agent Runtime) exists; until then nothing is exported
// but the module itself.
export { ProjectsModule } from './projects.module';
