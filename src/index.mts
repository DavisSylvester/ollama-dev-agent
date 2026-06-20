#!/usr/bin/env bun
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import { App } from './ui/App.tsx';
import { DevAgent } from './agent/index.mts';
import { agentEvents, uiEvents } from './agent/events.mts';
import { env } from './env.mts';
import type { AgentConfig } from './types/index.mts';

const program = new Command();

program
  .name('oda')
  .description('Ollama Dev Agent — autonomous local coding agent with Ralph loop')
  .version('0.1.0')
  .argument('[prompt]', 'Feature or task to implement', 'build a kanban API')
  .option('-d, --cwd <directory>', 'Working directory', process.cwd())
  .option('-i, --max-iter <number>', 'Maximum Ralph loop iterations per task', String(env.MAX_ITERATIONS))
  .option('--no-prd-review', 'Skip PRD review and execute immediately')
  .option('--prd-file <path>', 'Use an existing PRD file instead of generating one')
  .parse(process.argv);

const [prompt] = program.args as [string];
const opts = program.opts<{
  cwd: string;
  maxIter: string;
  prdReview: boolean;
  prdFile?: string;
}>();

const workingDirectory = resolve(opts.cwd);
const maxIterations = parseInt(opts.maxIter, 10);

const config: AgentConfig = {
  workingDirectory,
  maxIterations,
  prdFile: opts.prdFile,
};

const agent = new DevAgent(config);

let agentStarted = false;

function startAgent(): void {
  if (agentStarted) return;
  agentStarted = true;

  // If PRD review is skipped, auto-approve
  if (!opts.prdReview) {
    agentEvents.once('prd_generated', () => {
      uiEvents.emit('prd_approved');
    });
  }

  agent.run(prompt).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    agentEvents.emit('error', { type: 'error', payload: { message }, timestamp: DateTime.utc().toISO() });
  });
}

const { waitUntilExit } = render(
  React.createElement(App, {
    version: '0.1.0',
    onAgentStart: startAgent,
  }),
);

await waitUntilExit();
