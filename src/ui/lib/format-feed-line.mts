const PERSONA_LABELS: Record<string, string> = {
  scrum_master: 'Scrum Master',
  solution_architect: 'Solution Architect',
  sme: 'SME',
  developer: 'Developer',
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
    default:
      return null;
  }
}
