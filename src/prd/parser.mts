import type { Task } from '../types/index.mts';

export function extractFeatureSlug(prd: string): string {
  const slugMatch = prd.match(/\*\*Feature Slug\*\*:\s*([^\n\r]+)/);
  if (slugMatch?.[1]) {
    return slugMatch[1].trim();
  }

  // Fallback: derive from the first heading
  const headingMatch = prd.match(/^#\s+PRD:\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return slugify(headingMatch[1].trim());
  }

  return 'unknown-feature';
}

export function extractFeatureName(prd: string): string {
  const match = prd.match(/^#\s+PRD:\s+(.+)$/m);
  if (match?.[1]) {
    return match[1].trim();
  }
  return 'Unknown Feature';
}

export function parseTasks(prd: string): Task[] {
  const tasks: Task[] = [];

  // Match top-level task lines: - [ ] **TASK-XXX**: <name>  OR  - [x] **TASK-XXX**: <name>
  const taskPattern = /^- \[([ x])\] \*\*(TASK-\d+)\*\*:\s*(.+)$/gm;

  let taskMatch: RegExpExecArray | null;
  const rawMatches: Array<{ id: string; name: string; index: number; checked: boolean }> = [];

  while ((taskMatch = taskPattern.exec(prd)) !== null) {
    rawMatches.push({
      checked: taskMatch[1] === 'x',
      id: taskMatch[2]!,
      name: taskMatch[3]!.trim(),
      index: taskMatch.index,
    });
  }

  for (let i = 0; i < rawMatches.length; i++) {
    const current = rawMatches[i]!;
    const nextIndex =
      i + 1 < rawMatches.length ? rawMatches[i + 1]!.index : prd.length;

    // Extract the block of text belonging to this task
    const block = prd.slice(current.index, nextIndex);

    const description = extractSubBullet(block, 'Description');
    const acceptanceCriteria = extractSubBullet(block, 'Acceptance');
    const testCommand = extractTestCommand(block);
    const dependsOn = extractDependsOn(block);

    tasks.push({
      id: current.id,
      name: current.name,
      description,
      acceptanceCriteria,
      testCommand,
      dependsOn,
      status: current.checked ? 'complete' : 'pending',
      iterationCount: 0,
    });
  }

  return tasks;
}

export function updateTaskStatus(
  prd: string,
  taskId: string,
  complete: boolean,
): string {
  const escapedId = taskId.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');

  if (complete) {
    return prd.replace(
      new RegExp(`- \\[ \\] \\*\\*${escapedId}\\*\\*`),
      `- [x] **${taskId}**`,
    );
  } else {
    return prd.replace(
      new RegExp(`- \\[x\\] \\*\\*${escapedId}\\*\\*`),
      `- [ ] **${taskId}**`,
    );
  }
}

// --- helpers ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function extractSubBullet(block: string, label: string): string {
  // Match lines like:   - **Description**: <value>
  // or multi-line indented values
  const pattern = new RegExp(
    `- \\*\\*${label}\\*\\*:\\s*([^\\n]+(?:\\n(?!\\s*- \\*\\*)[^\\n]*)*)`,
  );
  const match = block.match(pattern);
  if (match?.[1]) {
    return match[1].trim();
  }
  return '';
}

function extractDependsOn(block: string): readonly string[] {
  const raw = extractSubBullet(block, 'Depends On');
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^TASK-\d+$/.test(s));
}

function extractTestCommand(block: string): string {
  // Match: - **Test Command**: `<command>`
  const backtickPattern = /- \*\*Test Command\*\*:\s*`([^`]+)`/;
  const backtickMatch = block.match(backtickPattern);
  if (backtickMatch?.[1]) {
    return backtickMatch[1].trim();
  }

  // Fallback: unquoted command
  const plainPattern = /- \*\*Test Command\*\*:\s*([^\n]+)/;
  const plainMatch = block.match(plainPattern);
  if (plainMatch?.[1]) {
    return plainMatch[1].trim();
  }

  return '';
}
