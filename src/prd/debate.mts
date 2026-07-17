import type { Task } from '../types/index.mts';
import { env } from '../env.mts';
import { createChatModel } from '../models/index.mts';
import { HumanMessage, SystemMessage, type AIMessage } from '@langchain/core/messages';
import { logger } from '../logger.mts';
import {
  buildDebateProposalPrompt,
  buildPersonaCritiquePrompt,
  buildDebateSynthesisPrompt,
} from './prompts.mts';

export const DEBATE_PERSONAS = ['scrum_master', 'solution_architect', 'sme', 'developer'] as const;
export type DebatePersona = (typeof DEBATE_PERSONAS)[number];

export interface ProposedStory {
  name: string;
  description: string;
  acceptanceCriteria: string;
}

export interface PersonaStance {
  persona: DebatePersona;
  verdict: 'agree' | 'revise';
  comments: string;
}

export interface DebateRound {
  round: number;
  proposal: ProposedStory[];
  stances: PersonaStance[];
}

export interface DebateResult {
  taskId: string;
  taskName: string;
  rounds: DebateRound[];
  finalStories: ProposedStory[];
  decidedBy: 'consensus' | 'architect';
  transcript: string;
}

export class DebateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DebateError';
  }
}

// Tiered defaults: SA + SME reason on the planner model; Scrum + Dev on the
// cheaper coder model. Any DEBATE_*_MODEL override wins.
export function personaModel(persona: DebatePersona): string {
  switch (persona) {
    case 'solution_architect':
      return env.DEBATE_ARCHITECT_MODEL ?? env.PLANNER_MODEL;
    case 'sme':
      return env.DEBATE_SME_MODEL ?? env.PLANNER_MODEL;
    case 'scrum_master':
      return env.DEBATE_SCRUM_MODEL ?? env.CODER_MODEL;
    case 'developer':
      return env.DEBATE_DEV_MODEL ?? env.CODER_MODEL;
  }
}

// Pull the first JSON value out of a model reply that may be fenced or padded
// with prose. Returns null if nothing parses.
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  const open = body[start]!;
  const close = open === '[' ? ']' : '}';
  const end = body.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function parseStories(raw: string): ProposedStory[] {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        name: asString(o.name).trim(),
        description: asString(o.description).trim(),
        acceptanceCriteria: asString(o.acceptanceCriteria).trim(),
      };
    })
    .filter((s) => s.name.length > 0);
}

export function parseStance(persona: DebatePersona, raw: string): PersonaStance {
  const parsed = extractJson(raw) as Record<string, unknown> | null;
  const verdict = asString(parsed?.verdict).trim().toLowerCase() === 'agree' ? 'agree' : 'revise';
  return { persona, verdict, comments: asString(parsed?.comments).trim() };
}

export interface DebateDeps {
  proposeFn?: (task: Task) => Promise<string>;
  critiqueFn?: (persona: DebatePersona, task: Task, proposal: ProposedStory[], round: number) => Promise<string>;
  synthesizeFn?: (task: Task, proposal: ProposedStory[], stances: PersonaStance[]) => Promise<string>;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

function extractContent(aiMessage: AIMessage): string {
  const content = aiMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : typeof b === 'object' && b !== null && 'text' in b && typeof (b as { text: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
      )
      .join('');
  }
  return String(content);
}

async function invoke(modelName: string, systemPrompt: string): Promise<string> {
  const model = createChatModel(modelName);
  const res = (await model.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage('Respond now with only the requested JSON.'),
  ])) as AIMessage;
  return extractContent(res);
}

function renderTranscript(rounds: DebateRound[], decidedBy: DebateResult['decidedBy']): string {
  const body = rounds
    .map((r) => {
      const votes = r.stances.map((s) => `  ${s.persona}: ${s.verdict} — ${s.comments}`).join('\n');
      return `Round ${r.round} (${r.proposal.length} stories)\n${votes}`;
    })
    .join('\n\n');
  return `${body}\n\nDecided by: ${decidedBy}`;
}

export async function runDebate(task: Task, deps?: DebateDeps): Promise<DebateResult> {
  const propose = deps?.proposeFn ?? ((t: Task) => invoke(personaModel('solution_architect'), buildDebateProposalPrompt(t)));
  const critique =
    deps?.critiqueFn ??
    ((p: DebatePersona, t: Task, prop: ProposedStory[], round: number) =>
      invoke(personaModel(p), buildPersonaCritiquePrompt(p, t, prop, round)));
  const synthesize =
    deps?.synthesizeFn ??
    ((t: Task, prop: ProposedStory[], stances: PersonaStance[]) =>
      invoke(personaModel('solution_architect'), buildDebateSynthesisPrompt(t, prop, stances)));

  let proposal = parseStories(await propose(task));
  if (proposal.length === 0) {
    throw new DebateError(`Debate for ${task.id} produced no opening proposal`);
  }
  deps?.onEvent?.('debate_started', { taskId: task.id, taskName: task.name });

  const rounds: DebateRound[] = [];
  let decidedBy: DebateResult['decidedBy'] = 'architect';
  const maxRounds = env.DEBATE_MAX_ROUNDS;

  for (let round = 1; round <= maxRounds; round++) {
    const stances: PersonaStance[] = [];
    for (const persona of DEBATE_PERSONAS) {
      const stance = parseStance(persona, await critique(persona, task, proposal, round));
      stances.push(stance);
      deps?.onEvent?.('persona_stance', {
        taskId: task.id,
        round,
        persona: stance.persona,
        verdict: stance.verdict,
        comments: stance.comments,
      });
    }
    rounds.push({ round, proposal, stances });

    if (stances.every((s) => s.verdict === 'agree')) {
      decidedBy = 'consensus';
      break;
    }
    if (round === maxRounds) {
      decidedBy = 'architect';
      break;
    }

    const revised = parseStories(await synthesize(task, proposal, stances));
    if (revised.length > 0) proposal = revised; // keep prior proposal if synthesis garbles
  }

  logger.info({ taskId: task.id, decidedBy, rounds: rounds.length }, 'debate.decided');
  deps?.onEvent?.('debate_decided', { taskId: task.id, decidedBy, storyCount: proposal.length });
  return {
    taskId: task.id,
    taskName: task.name,
    rounds,
    finalStories: proposal,
    decidedBy,
    transcript: renderTranscript(rounds, decidedBy),
  };
}
