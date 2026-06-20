import { mkdir, writeFile, readFile, readdir, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { DateTime } from 'luxon';
import type { Task } from '../types/index.mts';

export class ContextManager {

  constructor(
    private readonly workingDirectory: string,
    private readonly featureSlug: string,
  ) {}

  private taskDir(taskId: string): string {
    return join(
      this.workingDirectory,
      '.ai',
      'activity',
      this.featureSlug,
      taskId,
    );
  }

  async saveWorkerOutput(
    taskId: string,
    iteration: number,
    output: string,
  ): Promise<void> {
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `worker-${iteration}.md`), output, 'utf-8');
  }

  // Write goal.md at task start so anyone reviewing the activity folder can see
  // exactly what the task is trying to achieve, without reading worker logs.
  async saveTaskGoal(task: Task): Promise<void> {
    const dir = this.taskDir(task.id);
    await mkdir(dir, { recursive: true });
    const dependsOn =
      task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none';
    const content = [
      `# Goal — ${task.id}: ${task.name}`,
      ``,
      `**Feature:** ${this.featureSlug}`,
      `**Depends on:** ${dependsOn}`,
      ``,
      `## What this task is trying to achieve`,
      ``,
      task.description,
      ``,
      `## Definition of done (acceptance criteria)`,
      ``,
      task.acceptanceCriteria,
      ``,
      `## How it is verified`,
      ``,
      `\`${task.testCommand}\``,
      ``,
    ].join('\n');
    await writeFile(join(dir, 'goal.md'), content, 'utf-8');
  }

  async saveReviewerFeedback(
    taskId: string,
    iteration: number,
    feedback: string,
  ): Promise<void> {
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `reviewer-${iteration}.md`), feedback, 'utf-8');
  }

  async saveActivityEntry(taskId: string, entry: string): Promise<void> {
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'activity.md');
    let prefix = '';
    try {
      await access(path, constants.F_OK);
    } catch {
      prefix =
        '# Failed Iteration Activity Log\n\n' +
        'Tracks what each failed iteration attempted so future iterations avoid repeating the same mistakes.\n\n';
    }
    await appendFile(path, prefix + entry, 'utf-8');
  }

  async loadActivityLog(taskId: string): Promise<string> {
    const path = join(this.taskDir(taskId), 'activity.md');
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return '';
    }
  }

  async saveReviewerNoData(
    taskId: string,
    iteration: number,
    reason: string,
  ): Promise<void> {
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    const timestamp = DateTime.utc().toISO() ?? '';
    const content = [
      `# Reviewer — No Data`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| Task ID | \`${taskId}\` |`,
      `| Iteration | ${iteration} |`,
      `| Timestamp | ${timestamp} |`,
      ``,
      `## Reason`,
      ``,
      reason,
    ].join('\n');
    await writeFile(join(dir, `reviewer-${iteration}-no-data.md`), content, 'utf-8');
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.complete'), DateTime.utc().toISO() ?? '', 'utf-8');
  }

  async isTaskComplete(taskId: string): Promise<boolean> {
    const completePath = join(this.taskDir(taskId), '.complete');
    try {
      await access(completePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async loadLastReviewerFeedback(taskId: string): Promise<string> {
    const dir = this.taskDir(taskId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return '';
    }

    const reviewerIterations = entries
      .map((name) => {
        const match = name.match(/^reviewer-(\d+)\.md$/);
        return match?.[1] != null ? parseInt(match[1], 10) : null;
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);

    if (reviewerIterations.length === 0) return '';

    const lastIteration = reviewerIterations[reviewerIterations.length - 1]!;
    const feedbackPath = join(this.taskDir(taskId), `reviewer-${lastIteration}.md`);

    try {
      return await readFile(feedbackPath, 'utf-8');
    } catch {
      return '';
    }
  }

  async listIterations(taskId: string): Promise<number[]> {
    const dir = this.taskDir(taskId);

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const iterations = entries
      .map((name) => {
        const match = name.match(/^worker-(\d+)\.md$/);
        return match?.[1] != null ? parseInt(match[1], 10) : null;
      })
      .filter((n): n is number => n !== null)
      .sort((a, b) => a - b);

    return iterations;
  }
}
