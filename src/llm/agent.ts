import Anthropic from '@anthropic-ai/sdk';
import type { FeedSummary } from '../worker/api';
import {
  epochToLocalString,
  hourInTz,
  nowUnix,
  previousServiceDate,
  serviceDateInTz,
} from '../lib/time';
import { toolDefinitions } from './tools';

const MAX_TOOL_ITERATIONS = 12;

const STATIC_SYSTEM = `You are GTFS Chat, a transit assistant. A GTFS feed is loaded into an in-browser SQLite database and you answer questions about it (stops, routes, departures, arrivals, delays, alerts) using the provided tools.

Rules:
- Always resolve stop names with the search_stops tool before calling any schedule tool. Never guess or invent stop IDs, route IDs, or trip IDs — they must come from tool results.
- If several distinct stops plausibly match the user's query, ask the user which one they mean instead of picking arbitrarily.
- Show times exactly as returned by the tools (the "time" fields, already formatted HH:MM in the feed's timezone). Never do time arithmetic yourself.
- Mark realtime estimates as such (e.g. "(live)") and mention delays when the tools report them. Report canceled trips and skipped stops when flagged.
- Tool results with an empty list include a "hint" field explaining why — relay that reason to the user.
- Be concise. Answer in the language the user writes in.`;

function buildSystemBlocks(summary: FeedSummary): Anthropic.TextBlockParam[] {
  const now = nowUnix();
  const tz = summary.timezone;
  const serviceDate = serviceDateInTz(tz, now);
  const lateNight = hourInTz(tz, now) < 5;
  const agencyNames = summary.agencies.map((a) => a.name).join(', ') || 'unknown agency';

  const dynamic = [
    `Current time: ${now} (unix seconds) = ${epochToLocalString(now, tz)} in the feed's timezone (${tz}).`,
    `Current service date: ${serviceDate} (getTripSchedules-style dates are service dates in YYYYMMDD).`,
    lateNight
      ? `It is late night: trips started on the previous service date (${previousServiceDate(serviceDate)}) may still be running — query that date too when looking for departures happening now.`
      : `Note: after midnight, trips of the previous service date may still be running.`,
    `Loaded feed: ${agencyNames} — ${summary.stopCount} stops, ${summary.routeCount} routes.`,
    summary.serviceDateRange
      ? `The feed contains service from ${summary.serviceDateRange.start} to ${summary.serviceDateRange.end}.`
      : '',
    summary.hasRealtime
      ? 'Realtime (GTFS-RT) feeds are configured: departures include live estimates, alerts and vehicle positions are available.'
      : 'No realtime feeds are configured: all times are scheduled; alerts and vehicle positions are unavailable.',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    // Static block carries the cache breakpoint so the stable prefix
    // (tools + this block) is cached across the loop's many calls;
    // the volatile time/feed block stays after the breakpoint.
    { type: 'text', text: STATIC_SYSTEM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamic },
  ];
}

export interface AgentEvents {
  /** A new assistant message begins (each loop iteration may produce one). */
  onAssistantStart: () => void;
  onTextDelta: (delta: string) => void;
  /** Tools started executing (names in call order). */
  onToolStart: (names: string[]) => void;
}

export interface AgentTurnResult {
  /** Messages to append to the conversation history (assistant + tool results). */
  messages: Anthropic.MessageParam[];
  hitIterationCap: boolean;
}

export async function runAgentTurn(options: {
  apiKey: string;
  model: string;
  summary: FeedSummary;
  history: Anthropic.MessageParam[];
  executeTool: (name: string, input: unknown) => Promise<string>;
  events: AgentEvents;
}): Promise<AgentTurnResult> {
  const { apiKey, model, summary, history, executeTool, events } = options;
  // BYOK: the key goes directly from the browser to api.anthropic.com only.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const appended: Anthropic.MessageParam[] = [];
  const system = buildSystemBlocks(summary);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const stream = client.messages.stream({
      model,
      max_tokens: 2048,
      system,
      tools: toolDefinitions,
      messages: [...history, ...appended],
    });

    events.onAssistantStart();
    stream.on('text', (delta) => events.onTextDelta(delta));

    const message = await stream.finalMessage();

    if (message.stop_reason === 'pause_turn') {
      appended.push({ role: 'assistant', content: message.content });
      continue;
    }

    if (message.stop_reason !== 'tool_use') {
      appended.push({ role: 'assistant', content: message.content });
      return { messages: appended, hitIterationCap: false };
    }

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );
    appended.push({ role: 'assistant', content: message.content });
    events.onToolStart(toolUses.map((t) => t.name));

    const results = await Promise.all(
      toolUses.map(
        async (toolUse): Promise<Anthropic.ToolResultBlockParam> => ({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: await executeTool(toolUse.name, toolUse.input),
        })
      )
    );
    appended.push({ role: 'user', content: results });
  }

  return { messages: appended, hitIterationCap: true };
}

/** Map an error from the agent loop to a user-facing banner message. */
export function describeAgentError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected the API key (401). Check your key in Settings.';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'The API key is not allowed to use this model (403). Try another model in Settings.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Anthropic API (429). Wait a moment and try again.';
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com — check your network connection.';
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error (${error.status ?? 'unknown'}): ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
