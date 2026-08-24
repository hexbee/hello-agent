// Product event contract — docs/desktop-agent-tech-stack.md §6.1
// Single source of truth for Main → Renderer events.

export type EventBase = {
  version: 1;
  sequence: number;
  sessionId: string;
  timestamp: number;
};

export type SafePreview = {
  text: string;
  truncated: boolean;
  redacted: boolean;
};

export type AgentEvent =
  | (EventBase & { type: "message.started"; messageId: string; role: "assistant" })
  | (EventBase & { type: "message.delta"; messageId: string; delta: string })
  | (EventBase & { type: "message.finished"; messageId: string })
  | (EventBase & { type: "thinking.delta"; messageId: string; delta: string })
  | (EventBase & {
      type: "tool.started";
      toolCallId: string;
      toolName: string;
      inputPreview: SafePreview;
    })
  | (EventBase & { type: "tool.updated"; toolCallId: string; outputPreview: SafePreview })
  | (EventBase & {
      type: "tool.finished";
      toolCallId: string;
      isError: boolean;
      resultPreview: SafePreview;
      patch?: SafePreview;
    })
  | (EventBase & { type: "agent.state"; state: "running" | "idle" | "aborted" | "failed" })
  | (EventBase & {
      type: "agent.failed";
      kind: "llm" | "tool" | "permission" | "network" | "runtime";
      message: string;
    })
  | (EventBase & { type: "context.compaction"; phase: "started" | "finished" })
  | (EventBase & {
      type: "approval.requested";
      requestId: string;
      toolCallId: string;
      toolName: string;
      displayInput: SafePreview;
    })
  | (EventBase & {
      type: "approval.resolved";
      requestId: string;
      decision: "allow" | "deny" | "cancelled" | "expired";
    })
  | (EventBase & { type: "session.renamed"; name: string });

/** Non-delta events pass through immediately; deltas go through the bounded batcher (§6.3). */
export function isDeltaEvent(event: AgentEvent): boolean {
  return event.type === "message.delta" || event.type === "thinking.delta";
}

export type AgentSnapshot = {
  version: 1;
  lastSequence: number;
  cwd: string;
  trust: "untrusted" | "restricted" | "trusted";
  session: {
    id: string;
    file: string | undefined;
    name: string | undefined;
  };
  agentState: "running" | "idle" | "aborted" | "failed";
  messages: Array<{
    messageId: string;
    role: "user" | "assistant";
    text: string;
    thinking?: string;
  }>;
  activeToolPreviews: Array<{ toolCallId: string; toolName: string; preview: SafePreview }>;
  pendingApprovals: Array<{
    requestId: string;
    toolCallId: string;
    toolName: string;
    displayInput: SafePreview;
    createdAt: number;
  }>;
  authState: {
    configured: boolean;
    provider: string | null;
    /** Masked hint only, never credentials. e.g. "sk-…abcd" */
    maskedHint: string | null;
    /** Set when secure storage itself failed (§8 error states). */
    storageError?: string;
  };
  /** Provider auth capabilities for the auth dialog (no secrets). */
  authProviders: Array<{
    id: string;
    name: string;
    supportsApiKey: boolean;
    supportsOAuth: boolean;
    configured: boolean;
  }>;
  models: Array<{ provider: string; id: string; context: number | null }>;
  selectedModel: string | null;
  /** User messages with real JSONL entry ids — fork selector source (§5.1 session.fork). */
  forkCandidates: Array<{ entryId: string; text: string }>;
};
