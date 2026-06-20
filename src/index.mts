#!/usr/bin/env bun
import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { resolve } from 'node:path';
import { DateTime } from 'luxon';
import { App } from './ui/App.tsx';
import { DevAgent } from './agent/index.mts';
import { agentEvents, uiEvents } from './agent/events.mts';
import { env, applyEnvOverrides } from './env.mts';
import type { Env } from './env.mts';
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
  // Model overrides (take precedence over .env for this run)
  .option('--planner-model <model>', 'Override the planner model')
  .option('--coder-model <model>', 'Override the worker/coder model')
  .option('--editor-model <model>', 'Override the reviewer/editor model')
  // Ollama endpoint
  .option('--base-url <url>', 'Override the Ollama base URL')
  .option('--cloud', 'Target Ollama Cloud (https://ollama.com); API key still comes from .env')
  // Planning behavior
  .option('--no-research', 'Disable web-search planning (fast single-shot PRD)')
  // Step budgets
  .option('--planner-max-steps <number>', 'Override the planner research step budget')
  .option('--max-react-steps <number>', 'Override the worker ReAct step budget')
  .parse(process.argv);

const [prompt] = program.args as [string];
const opts = program.opts<{
  cwd: string;
  maxIter: string;
  prdReview: boolean;
  prdFile?: string;
  plannerModel?: string;
  coderModel?: string;
  editorModel?: string;
  baseUrl?: string;
  cloud?: boolean;
  research: boolean;
  plannerMaxSteps?: string;
  maxReactSteps?: string;
}>();

// Translate CLI flags into env overrides before the agent reads any config.
const overrides: Partial<Env> = {};
if (opts.plannerModel) overrides.PLANNER_MODEL = opts.plannerModel;
if (opts.coderModel) overrides.CODER_MODEL = opts.coderModel;
if (opts.editorModel) overrides.EDITOR_MODEL = opts.editorModel;
if (opts.cloud) overrides.OLLAMA_BASE_URL = 'https://ollama.com';
if (opts.baseUrl) overrides.OLLAMA_BASE_URL = opts.baseUrl; // explicit --base-url wins over --cloud
if (opts.research === false) overrides.RESEARCH_PLANNING = false; // env governs when flag absent
const plannerSteps = opts.plannerMaxSteps ? parseInt(opts.plannerMaxSteps, 10) : NaN;
if (!Number.isNaN(plannerSteps)) overrides.PLANNER_MAX_STEPS = plannerSteps;
const reactSteps = opts.maxReactSteps ? parseInt(opts.maxReactSteps, 10) : NaN;
if (!Number.isNaN(reactSteps)) overrides.MAX_REACT_STEPS = reactSteps;
applyEnvOverrides(overrides);

const workingDirectory = resolve(opts.cwd);
const maxIterations = parseInt(opts.maxIter, 10);

const config: AgentConfig = {
  workingDirectory,
  maxIterations,
  ...(opts.prdFile ? { prdFile: opts.prdFile } : {}),
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
