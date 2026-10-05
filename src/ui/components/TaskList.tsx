import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Task } from '../../types/index.mts';

interface TaskListProps {
  readonly tasks: Task[];
  readonly currentTaskIndex: number;
}

// Above this many tasks, completed and blocked tasks collapse into one summary
// line each, so the running/failed/next tasks stay visible.
const COLLAPSE_ABOVE = 15;
const MAX_PENDING_ROWS = 5;

export function TaskList({ tasks, currentTaskIndex }: TaskListProps): React.ReactElement {
  const count = (status: Task['status']): number => tasks.filter((t) => t.status === status).length;
  const complete = count('complete');
  const running = count('in_progress');
  const failed = count('failed');
  const blocked = count('blocked');
  const pending = count('pending');
  const collapse = tasks.length > COLLAPSE_ABOVE;

  const blockers = [...new Set(tasks.filter((t) => t.status === 'blocked').flatMap((t) => t.blockedBy ?? []))].sort();
  const pendingRows = tasks.filter((t) => t.status === 'pending').slice(0, MAX_PENDING_ROWS);
  const visible = collapse
    ? tasks.filter((t) => t.status === 'in_progress' || t.status === 'failed' || pendingRows.includes(t))
    : tasks;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold underline color="white">Tasks</Text>
        <Text dimColor>  {tasks.length} total · </Text>
        <Text color="green">{complete} done</Text>
        <Text dimColor> · </Text>
        <Text color="yellow">{running} running</Text>
        <Text dimColor> · {pending} waiting</Text>
        {failed > 0 && <Text color="red"> · {failed} failed</Text>}
        {blocked > 0 && <Text color="magenta"> · {blocked} blocked</Text>}
      </Text>
      {collapse && complete > 0 && <Text color="green">✓ {complete} completed</Text>}
      {visible.map((task) => (
        <TaskRow key={task.id} task={task} isCurrent={tasks.indexOf(task) === currentTaskIndex} />
      ))}
      {collapse && pending > pendingRows.length && (
        <Text dimColor>○ …and {pending - pendingRows.length} more waiting</Text>
      )}
      {collapse && blocked > 0 && (
        <Text color="magenta">⊘ {blocked} blocked — waiting on {blockers.join(', ') || 'a failed task'}</Text>
      )}
    </Box>
  );
}

interface TaskRowProps {
  readonly task: Task;
  readonly isCurrent: boolean;
}

function TaskRow({ task, isCurrent }: TaskRowProps): React.ReactElement {
  switch (task.status) {
    case 'complete':
      return (
        <Box gap={1}>
          <Text color="green">✓</Text>
          <Text color="green">{task.id}: {task.name}</Text>
        </Box>
      );

    case 'failed':
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="red">✗</Text>
            <Text color="red">{task.id}: {task.name}</Text>
          </Box>
          {task.failureReason && <Text dimColor wrap="truncate-end">    {task.failureReason}</Text>}
        </Box>
      );

    case 'blocked':
      return (
        <Box gap={1}>
          <Text color="magenta">⊘</Text>
          <Text color="magenta">
            {task.id}: {task.name}
            <Text dimColor> (blocked by {(task.blockedBy ?? []).join(', ') || 'a failed task'})</Text>
          </Text>
        </Box>
      );

    case 'in_progress':
      return (
        <Box gap={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text color="yellow">
            {task.id}: {task.name}
            {task.iterationCount > 0 && (
              <Text dimColor> (iteration {task.iterationCount})</Text>
            )}
          </Text>
        </Box>
      );

    case 'pending':
    default:
      return (
        <Box gap={1}>
          <Text dimColor>○</Text>
          <Text dimColor>
            {task.id}: {task.name}
            {isCurrent && <Text color="cyan"> ← next</Text>}
          </Text>
        </Box>
      );
  }
}
