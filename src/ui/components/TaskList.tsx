import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Task } from '../../types/index.mts';

interface TaskListProps {
  readonly tasks: Task[];
  readonly currentTaskIndex: number;
}

export function TaskList({ tasks, currentTaskIndex }: TaskListProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold underline color="white">Tasks</Text>
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          isCurrent={index === currentTaskIndex}
        />
      ))}
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
        <Box gap={1}>
          <Text color="red">✗</Text>
          <Text color="red">{task.id}: {task.name}</Text>
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
