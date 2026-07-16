import { DateTime } from 'luxon';
import type { SizedPlanResult } from './sizer.mts';

export function buildSizingReport(
  featureName: string,
  featureSlug: string,
  result: SizedPlanResult,
): string {
  const { distribution, tasks, splits } = result;

  const taskRows = tasks
    .map((t) => `| ${t.id} | ${t.domain} | ${t.size ?? '?'} | ${t.name} |`)
    .join('\n');

  const splitRows =
    splits.length > 0
      ? splits.map((s) => `- ${s.parentId} → ${s.childIds.join(', ')}`).join('\n')
      : '_No proactive splits were required._';

  return `# Sizing: ${featureName}

**Feature Slug**: ${featureSlug}
**Generated**: ${DateTime.utc().toISO()}

## Size Distribution

| Size | Count |
|------|-------|
| S | ${distribution.S} |
| M | ${distribution.M} |
| L | ${distribution.L} |

## Tasks

| ID | Domain | Size | Name |
|----|--------|------|------|
${taskRows}

## Proactive Splits

${splitRows}
`;
}
