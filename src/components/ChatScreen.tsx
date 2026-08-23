import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type Anthropic from '@anthropic-ai/sdk';
import type { Remote } from 'comlink';
import type { FeedSummary, GtfsWorkerApi } from '../worker/api';
import type { StopIndex } from '../search/stopIndex';
import { describeAgentError, runAgentTurn } from '../llm/agent';
import { executeTool, TOOL_LABELS, type ToolContext } from '../llm/tools';
import { getApiKey, getModel } from '../lib/settings';
import {
  addUsage,
  EMPTY_USAGE,
  formatCost,
  formatTokens,
  type UsageTotals,
} from '../lib/pricing';

interface DisplayMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
}

interface Props {
  worker: Remote<GtfsWorkerApi>;
  stopIndex: StopIndex;
  summary: FeedSummary;
  onOpenSettings: () => void;
  /** Bumped when settings change so the missing-key prompt re-evaluates. */
  settingsVersion: number;
}

export function ChatScreen({ worker, stopIndex, summary, onOpenSettings, settingsVersion }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageTotals>(EMPTY_USAGE);

  const historyRef = useRef<Anthropic.MessageParam[]>([]);
  const toolContextRef = useRef<ToolContext | null>(null);
  const nextIdRef = useRef(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (!toolContextRef.current) {
    toolContextRef.current = { worker, stopIndex, summary, lastRtFetch: null };
  }

  const hasKey = getApiKey().length > 0;
  // settingsVersion re-renders this component when the key/model change
  void settingsVersion;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, activeTool]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !hasKey) return;
    setInput('');
    setError(null);
    setBusy(true);

    const userMessage: DisplayMessage = { id: nextIdRef.current++, role: 'user', text };
    const assistantId = nextIdRef.current++;
    setMessages((prev) => [...prev, userMessage]);
    const historyLengthBeforeTurn = historyRef.current.length;
    historyRef.current.push({ role: 'user', content: text });

    const appendDelta = (delta: string) => {
      setActiveTool(null);
      setMessages((prev) => {
        const existing = prev.find((m) => m.id === assistantId);
        if (!existing) {
          return [...prev, { id: assistantId, role: 'assistant', text: delta }];
        }
        return prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + delta } : m));
      });
    };

    const model = getModel();
    try {
      const result = await runAgentTurn({
        apiKey: getApiKey(),
        model,
        summary,
        history: historyRef.current,
        executeTool: (name, toolInput) => executeTool(toolContextRef.current!, name, toolInput),
        events: {
          onAssistantStart: () => {},
          onTextDelta: appendDelta,
          onToolStart: (names) => {
            const label = TOOL_LABELS[names[0]] ?? `Running ${names[0]}…`;
            setActiveTool(names.length > 1 ? `${label} (+${names.length - 1} more)` : label);
          },
          onUsage: (turnUsage) => setUsage((prev) => addUsage(prev, turnUsage, model)),
        },
      });
      historyRef.current.push(...result.messages);
      if (result.hitIterationCap) {
        appendDelta(
          '\n\n*I hit the limit of tool calls for one question — try asking something more specific.*'
        );
      }
    } catch (err) {
      setError(describeAgentError(err));
      // Roll back this turn entirely so the history never contains a
      // dangling tool_use without its tool_result.
      historyRef.current = historyRef.current.slice(0, historyLengthBeforeTurn);
    } finally {
      setActiveTool(null);
      setBusy(false);
    }
  }, [input, busy, hasKey, summary]);

  const resetConversation = useCallback(() => {
    if (busy) return;
    setMessages([]);
    historyRef.current = [];
    setUsage(EMPTY_USAGE);
    setError(null);
    setActiveTool(null);
  }, [busy]);

  const agencyNames = summary.agencies.map((a) => a.name).join(', ');
  const totalIn = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;

  return (
    <div className="chat-screen">
      <header className="chat-header">
        <div>
          <h1>GTFS Chat</h1>
          <p className="feed-info">
            {agencyNames} · {summary.stopCount.toLocaleString()} stops ·{' '}
            {summary.routeCount.toLocaleString()} routes · {summary.timezone}
            {summary.hasRealtime ? ' · realtime ✓' : ''}
          </p>
        </div>
        <div className="chat-header-actions">
          {messages.length > 0 && (
            <button
              onClick={resetConversation}
              disabled={busy}
              title="Clear the conversation and start fresh"
            >
              ↺ New chat
            </button>
          )}
          <button className="icon-button" onClick={onOpenSettings} aria-label="Open settings">
            ⚙
          </button>
        </div>
      </header>

      {totalIn + usage.outputTokens > 0 && (
        <div
          className="usage-bar"
          title={`input: ${usage.inputTokens.toLocaleString()} · cache write: ${usage.cacheWriteTokens.toLocaleString()} · cache read: ${usage.cacheReadTokens.toLocaleString()} · output: ${usage.outputTokens.toLocaleString()}`}
        >
          ⬇ {formatTokens(totalIn)} in · ⬆ {formatTokens(usage.outputTokens)} out · ≈{' '}
          {formatCost(usage.costUsd)}
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <p>{error}</p>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {!hasKey && (
        <div className="banner banner-info">
          <p>Set your Anthropic API key to start chatting.</p>
          <button onClick={onOpenSettings}>Open settings</button>
        </div>
      )}

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>
              Ask about this network — e.g. <em>“When is the next departure from …?”</em> or{' '}
              <em>“Which routes stop at …?”</em>
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`chat-bubble chat-bubble-${message.role}`}>
            {message.role === 'assistant' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            ) : (
              <p>{message.text}</p>
            )}
          </div>
        ))}
        {activeTool && <div className="tool-indicator">{activeTool}</div>}
        {busy && !activeTool && <div className="tool-indicator">Thinking…</div>}
      </div>

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hasKey ? 'Ask about stops, routes, departures…' : 'Set an API key first'}
          disabled={busy || !hasKey}
        />
        <button type="submit" className="primary" disabled={busy || !hasKey || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
