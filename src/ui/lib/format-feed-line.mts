const PERSONA_LABELS: Record<string, string> = {
  scrum_master: 'Scrum Master',
  solution_architect: 'Solution Architect',
  sme: 'SME',
  developer: 'Developer',
};

const ITERATION_LABELS: Record<string, string> = {
  ship: 'SHIP ✓',
  revise: 'REVISE',
  lint_failed: 'lint failed',
  timeout: 'timed out',
  worker_error: 'model call failed',
  reviewer_error: 'reviewer error',
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Turn a sizing/debate feedback event into a single display line, or null for
// events this feed does not render.
export function formatFeedLine(type: string, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'sizing_started':
      return `Sizing ${String(payload['taskCount'])} tasks…`;
    case 'task_sized':
      return `${String(payload['taskId'])} = ${String(payload['size'])}`;
    case 'debate_started':
      return `Debating ${String(payload['taskId'])} (${String(payload['taskName'])})…`;
    case 'persona_stance': {
      const label = PERSONA_LABELS[String(payload['persona'])] ?? String(payload['persona']);
      const comments = truncate(String(payload['comments'] ?? ''), 80);
      return `  ${label}: ${String(payload['verdict'])} — ${comments}`;
    }
    case 'debate_decided':
      return `${String(payload['taskId'])}: decided by ${String(payload['decidedBy'])} → ${String(payload['storyCount'])} stories`;

    // --- Execution feedback: every wait, retry and outcome gets a line, so a
    // slow provider or a failing task never looks like a frozen screen.
    case 'task_started':
      return `▶ ${String(payload['taskId'])} started`;
    case 'iteration_finished': {
      const detail = truncate(String(payload['detail'] ?? '').replace(/^Worker encountered an unexpected error:\s*/, ''), 90);
      const label = ITERATION_LABELS[String(payload['outcome'])] ?? String(payload['outcome']);
      return `  ${String(payload['taskId'])} attempt ${String(payload['iteration'])}/${String(payload['maxIterations'])}: ${label}${detail ? ` — ${detail}` : ''}`;
    }
    case 'model_retry': {
      const seconds = Math.round(Number(payload['delayMs'] ?? 0) / 1000);
      const error = String(payload['error'] ?? '');
      const retry = `retry ${String(payload['attempt'])}/${String(payload['maxRetries'])} in ${seconds}s`;
      if (error.startsWith('Model thought for')) return `⟳ ${error} — ${retry}, told to act`;
      return `⟳ model call failed (${truncate(error, 60)}) — ${retry}`;
    }
    case 'quota_paused':
      return `⏸ model quota reached — pausing ${String(payload['waitMinutes'])} min, then retrying ${(payload['taskIds'] as string[] | undefined)?.join(', ') ?? ''}`;
    case 'dependencies_checked': {
      const upgraded = (payload['upgraded'] as unknown[] | undefined)?.length ?? 0;
      const pinned = (payload['pinned'] as unknown[] | undefined)?.length ?? 0;
      return `📦 dependencies: ${upgraded} upgraded, ${pinned} pinned (see docs/DEPENDENCIES.md)`;
    }
    case 'task_complete':
      return `✓ ${String(payload['taskId'])} complete after ${String(payload['iterations'])} attempt(s)`;
    case 'task_failed':
      return `✗ ${String(payload['taskId'])} failed — ${truncate(String(payload['reason'] ?? ''), 110)}`;
    case 'task_split':
      return `✂ ${String(payload['taskId'])} split into ${String(payload['count'])} smaller tasks`;
    case 'reviewer_decision': {
      const decision = payload['decision'] as { decision?: string; issues?: unknown[] } | undefined;
      const issues = decision?.issues?.length ?? 0;
      return `  ${String(payload['taskId'])} review: ${String(decision?.decision ?? '?').toUpperCase()}${issues > 0 ? ` (${issues} issue${issues === 1 ? '' : 's'})` : ''}`;
    }
    default:
      return null;
  }
}
