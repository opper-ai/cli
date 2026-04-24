# Hooks Reference (Node Agents)

Monitor and respond to agent lifecycle events with hooks. Use hooks for logging, debugging, metrics collection, and custom integrations.

## Contents
- [Registering Hooks](#registering-hooks)
- [Available Hook Events](#available-hook-events)
- [Agent Lifecycle Hooks](#agent-lifecycle-hooks)
- [Loop Hooks](#loop-hooks)
- [LLM Hooks](#llm-hooks)
- [Tool Hooks](#tool-hooks)
- [Correlating Tool Events](#correlating-tool-events)
- [Memory Hooks](#memory-hooks)
- [Stream Hooks](#stream-hooks)
- [Event Emitter Pattern](#event-emitter-pattern)
- [Best Practices](#best-practices)

## Registering Hooks

Register hooks using `registerHook()` or `on()`:

```typescript
import { Agent, HookEvents } from "@opperai/agents";

const agent = new Agent({
  name: "MyAgent",
  instructions: "Help users.",
});

// Using registerHook()
const unregister = agent.registerHook(HookEvents.AgentStart, ({ context }) => {
  console.log(`Agent started: ${context.agentName}`);
});

// Using on() - equivalent to registerHook()
agent.on(HookEvents.AgentEnd, ({ context, result }) => {
  console.log(`Agent finished with ${context.toolCalls.length} tool calls`);
});

// Unregister when no longer needed
unregister();
```

## Available Hook Events

| Event | Payload | When Triggered |
|-------|---------|----------------|
| `AgentStart` | `{ context }` | Agent execution begins |
| `AgentEnd` | `{ context, result?, error? }` | Agent execution completes |
| `LoopStart` | `{ context }` | Each iteration begins |
| `LoopEnd` | `{ context }` | Each iteration ends |
| `LlmCall` | `{ context, callType }` | LLM request starts |
| `LlmResponse` | `{ context, callType, response, parsed? }` | LLM response received |
| `ThinkEnd` | `{ context, thought }` | Agent reasoning complete |
| `BeforeTool` | `{ context, tool, input, toolCallId }` | Before tool execution |
| `AfterTool` | `{ context, tool, result, record }` | After tool execution |
| `ToolError` | `{ context, toolName, tool?, error, toolCallId }` | Tool execution failed |
| `MemoryRead` | `{ context, key, value }` | Memory read operation |
| `MemoryWrite` | `{ context, key, value }` | Memory write operation |
| `MemoryError` | `{ context, operation, error }` | Memory operation failed |
| `StreamStart` | `{ context, callType }` | Streaming begins |
| `StreamChunk` | `{ context, callType, chunkData, accumulated, fieldBuffers }` | Stream chunk received |
| `StreamEnd` | `{ context, callType, fieldBuffers }` | Streaming ends |
| `StreamError` | `{ context, callType, error }` | Stream error occurred |

## Agent Lifecycle Hooks

### AgentStart

Triggered when agent execution begins, before the first iteration.

```typescript
agent.on(HookEvents.AgentStart, ({ context }) => {
  console.log(`Session: ${context.sessionId}`);
  console.log(`Goal: ${JSON.stringify(context.goal)}`);
  console.log(`Parent span: ${context.parentSpanId ?? "none"}`);
});
```

**Payload:**
- `context.agentName` - Agent name
- `context.sessionId` - Unique session ID
- `context.goal` - Input passed to `run()` or `process()`
- `context.parentSpanId` - Parent span ID for tracing (null if root)

### AgentEnd

Triggered when agent execution completes, whether successful or failed.

```typescript
agent.on(HookEvents.AgentEnd, ({ context, result, error }) => {
  if (error) {
    console.error(`Failed: ${error}`);
  } else {
    console.log(`Result: ${JSON.stringify(result)}`);
  }
  console.log(`Iterations: ${context.iteration + 1}`);
  console.log(`Tool calls: ${context.toolCalls.length}`);
  console.log(`Tokens: ${context.usage.totalTokens}`);
});
```

**Payload:**
- `context` - Final agent context with usage stats
- `result` - Output value (present on success)
- `error` - Error object (present on failure)

## Loop Hooks

### LoopStart / LoopEnd

Triggered at the start and end of each agent iteration.

```typescript
agent.on(HookEvents.LoopStart, ({ context }) => {
  console.log(`Starting iteration ${context.iteration + 1}`);
});

agent.on(HookEvents.LoopEnd, ({ context }) => {
  console.log(`Completed iteration ${context.iteration + 1}`);
  console.log(`Total tokens: ${context.usage.totalTokens}`);
});
```

## LLM Hooks

### LlmCall

Triggered before each LLM API call.

```typescript
agent.on(HookEvents.LlmCall, ({ context, callType }) => {
  console.log(`LLM call: ${callType}`);
  // callType: "think" | "final_result"
});
```

### LlmResponse

Triggered after receiving an LLM response.

```typescript
agent.on(HookEvents.LlmResponse, ({ context, callType, response, parsed }) => {
  console.log(`LLM response for ${callType}`);
  console.log(`Input tokens: ${context.usage.inputTokens}`);
  console.log(`Output tokens: ${context.usage.outputTokens}`);
});
```

### ThinkEnd

Triggered after the agent completes its reasoning step.

```typescript
agent.on(HookEvents.ThinkEnd, ({ context, thought }) => {
  if (thought && typeof thought === "object") {
    const t = thought as Record<string, unknown>;
    console.log(`Reasoning: ${t.reasoning}`);
    console.log(`Tool calls planned: ${(t.toolCalls as unknown[])?.length ?? 0}`);
  }
});
```

## Tool Hooks

### BeforeTool

Triggered before a tool executes. Includes `toolCallId` for correlation.

```typescript
agent.on(HookEvents.BeforeTool, ({ context, tool, input, toolCallId }) => {
  console.log(`[${toolCallId}] Executing ${tool.name}`);
  console.log(`Input: ${JSON.stringify(input)}`);
});
```

**Payload:**
- `context` - Agent context
- `tool` - Tool definition object
- `input` - Input passed to the tool
- `toolCallId` - Unique ID for this tool call (matches `record.id` in AfterTool)

### AfterTool

Triggered after a tool completes (success or returned failure).

```typescript
agent.on(HookEvents.AfterTool, ({ context, tool, result, record }) => {
  console.log(`[${record.id}] ${tool.name} completed`);
  console.log(`Success: ${result.success}`);
  const duration = record.finishedAt - record.startedAt;
  console.log(`Duration: ${duration}ms`);
  if (result.success) {
    console.log(`Output: ${JSON.stringify(result.output)}`);
  }
});
```

**Payload:**
- `context` - Agent context
- `tool` - Tool definition object
- `result` - Tool result (`{ success, output }` or `{ success, error }`)
- `record` - Tool call record with `id`, `toolName`, `input`, `startedAt`, `finishedAt`

### ToolError

Triggered when a tool fails (returns failure or throws exception).

```typescript
agent.on(HookEvents.ToolError, ({ context, toolName, tool, error, toolCallId }) => {
  console.log(`[${toolCallId}] ${toolName} failed`);
  console.error(`Error: ${error}`);
  // tool may be undefined if tool was not found
});
```

**Payload:**
- `context` - Agent context
- `toolName` - Name of the tool
- `tool` - Tool definition (undefined if tool not found)
- `error` - Error that occurred
- `toolCallId` - Unique ID for this tool call (matches BeforeTool)

## Correlating Tool Events

Use `toolCallId` to track tool calls across `BeforeTool`, `AfterTool`, and `ToolError` events. This is essential in async environments with concurrent tool calls.

```typescript
const pendingTools = new Map<string, { name: string; startTime: number }>();

agent.on(HookEvents.BeforeTool, ({ tool, toolCallId }) => {
  pendingTools.set(toolCallId, { name: tool.name, startTime: Date.now() });
  console.log(`[${toolCallId}] Starting ${tool.name}`);
});

agent.on(HookEvents.AfterTool, ({ tool, result, record }) => {
  const pending = pendingTools.get(record.id);
  pendingTools.delete(record.id);
  const duration = Date.now() - (pending?.startTime ?? 0);
  console.log(`[${record.id}] ${tool.name} ${result.success ? "succeeded" : "failed"} in ${duration}ms`);
});

agent.on(HookEvents.ToolError, ({ toolName, toolCallId, error }) => {
  pendingTools.delete(toolCallId);
  console.log(`[${toolCallId}] ${toolName} error: ${error}`);
});
```

The `toolCallId` in `BeforeTool` matches:
- `record.id` in `AfterTool`
- `toolCallId` in `ToolError`

## Memory Hooks

Triggered when memory operations occur (requires `enableMemory: true`).

```typescript
agent.on(HookEvents.MemoryRead, ({ context, key, value }) => {
  console.log(`Memory read: ${key} = ${value !== undefined}`);
});

agent.on(HookEvents.MemoryWrite, ({ context, key, value }) => {
  console.log(`Memory write: ${key} = ${JSON.stringify(value)}`);
});

agent.on(HookEvents.MemoryError, ({ context, operation, error }) => {
  console.error(`Memory ${operation} failed: ${error}`);
});
```

## Stream Hooks

Triggered during streaming operations (requires `enableStreaming: true`).

```typescript
agent.on(HookEvents.StreamStart, ({ context, callType }) => {
  console.log(`Stream started: ${callType}`);
});

agent.on(HookEvents.StreamChunk, ({ callType, chunkData, accumulated }) => {
  if (callType === "final_result") {
    process.stdout.write(chunkData.delta ?? "");
  }
});

agent.on(HookEvents.StreamEnd, ({ callType, fieldBuffers }) => {
  console.log(`Stream ended: ${callType}`);
});

agent.on(HookEvents.StreamError, ({ callType, error }) => {
  console.error(`Stream error in ${callType}: ${error}`);
});
```

See [STREAMING.md](STREAMING.md) for detailed streaming patterns.

## Event Emitter Pattern

Use `on()`, `once()`, and `off()` for event-style handling:

```typescript
// Subscribe to events
const handler = ({ context }) => console.log(`Started: ${context.agentName}`);
agent.on(HookEvents.AgentStart, handler);

// One-time handler (auto-removes after first call)
agent.once(HookEvents.AgentEnd, ({ result }) => {
  console.log(`First run complete: ${result}`);
});

// Unsubscribe
agent.off(HookEvents.AgentStart, handler);
```

## Best Practices

- **Use toolCallId for correlation**: In async environments, rely on `toolCallId` to match `BeforeTool` with `AfterTool`/`ToolError` events instead of assuming sequential execution.

- **Handle errors gracefully**: Hook failures do not stop agent execution. Log errors within hooks to avoid silent failures.

- **Avoid blocking operations**: Hooks run in the agent's execution flow. Use async patterns for I/O operations.

- **Clean up subscriptions**: Call the unregister function when hooks are no longer needed to prevent memory leaks.

- **Use context.usage for metrics**: Access `context.usage.inputTokens`, `outputTokens`, `totalTokens`, and `cost` for usage tracking.

- **Check result.success**: In `AfterTool`, always check `result.success` before accessing `result.output` or `result.error`.

- **Filter by callType**: In LLM and stream hooks, use `callType` to distinguish between "think" (reasoning) and "final_result" (output generation) phases.
