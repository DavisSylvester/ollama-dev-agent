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

// Keywords that signal a domain in free-text description/acceptance. Used by the
// deterministic floor to detect a task that spans more than one domain.
export const DOMAIN_KEYWORDS: Record<TaskDomain, readonly string[]> = {
  ui: ['angular', 'component', 'frontend', 'front-end', 'css', 'scss', 'view', 'template'],
  api: ['elysia', 'endpoint', 'route', 'http server', 'controller', 'rest'],
  services: ['service', 'business logic', 'orchestration', 'use case', 'domain rule'],
  database: ['mongo', 'mongodb', 'repository', 'schema', 'collection', 'dal', 'persistence'],
  auth: ['auth', 'auth0', 'jwt', 'login', 'token', 'oauth', 'permission'],
  iac: ['terraform', 'infrastructure', 'provision', 'azure', 'container app'],
  e2e: ['playwright', 'e2e', 'end-to-end', 'browser test'],
  ci: ['github actions', 'workflow', 'ci', 'pipeline', 'deploy'],
};

export function isTaskDomain(value: string): value is TaskDomain {
  return (TASK_DOMAINS as readonly string[]).includes(value);
}
