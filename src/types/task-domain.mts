// The functional area a task belongs to. Exactly one per task.
export type TaskDomain =
  | 'ui'
  | 'api'
  | 'services'
  | 'database'
  | 'auth'
  | 'iac'
  | 'e2e'
  | 'ci';

// Canonical ordered list for validation and reporting.
export const TASK_DOMAINS: readonly TaskDomain[] = [
  'ui',
  'api',
  'services',
  'database',
  'auth',
  'iac',
  'e2e',
  'ci',
];

// DISTINCTIVE keywords that signal a domain in free-text description/acceptance.
// Used only by the deterministic floor's multi-domain check, so these are kept
// high-signal on purpose: generic words that appear in ordinary task prose
// (schema, route, service, test, component, view, controller, deploy, auth …)
// are deliberately excluded — they caused nearly every real task to be misread
// as multi-domain. Prefer tokens that name a specific technology or concept.
export const DOMAIN_KEYWORDS: Record<TaskDomain, readonly string[]> = {
  ui: ['angular', 'scss', 'standalone component', 'signal-based'],
  api: ['elysia', 'openapi', 'http route handler'],
  services: ['business logic', 'orchestration', 'use case', 'domain rule'],
  database: ['mongo', 'mongodb', 'repository port', 'aggregation pipeline'],
  auth: ['auth0', 'jwt', 'oauth'],
  iac: ['terraform', 'container app', 'bicep'],
  e2e: ['playwright', 'end-to-end test'],
  ci: ['github actions', 'ci pipeline'],
};

export function isTaskDomain(value: string): value is TaskDomain {
  return (TASK_DOMAINS as readonly string[]).includes(value);
}
