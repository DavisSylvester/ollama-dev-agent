import type { Task } from '../types/index.mts';
import { env } from '../env.mts';

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
