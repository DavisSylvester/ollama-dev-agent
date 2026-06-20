import { EventEmitter } from 'node:events';
import { DateTime } from 'luxon';

// Agent → UI events
export const agentEvents = new EventEmitter();
agentEvents.setMaxListeners(50);

// UI → Agent events (for user input like PRD approval)
export const uiEvents = new EventEmitter();
uiEvents.setMaxListeners(10);

// Helper to emit typed events
export function emitAgentEvent(type: string, payload: Record<string, unknown>): void {
  agentEvents.emit(type, { type, payload, timestamp: DateTime.utc().toISO() });
}

// Wait for UI approval of PRD — resolves true (approved) or false (rejected)
export async function waitForPRDApproval(): Promise<boolean> {
  return new Promise((resolve) => {
    uiEvents.once('prd_approved', () => resolve(true));
    uiEvents.once('prd_rejected', () => resolve(false));
  });
}
