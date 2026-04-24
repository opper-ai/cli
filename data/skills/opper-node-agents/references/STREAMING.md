# Streaming Reference (Node Agents)

Enable real-time token-by-token output from agents. Both the think loop and final result can stream incrementally.

## Contents
- [Enabling Streaming](#enabling-streaming)
- [Stream Callbacks](#stream-callbacks)
- [Call Types](#call-types)
- [Hook-Based Streaming](#hook-based-streaming)
- [Event Emitter Pattern](#event-emitter-pattern)
- [Chunk Data Structure](#chunk-data-structure)
- [Streaming with Structured Output](#streaming-with-structured-output)
- [Web Server Integration (Express)](#web-server-integration-express)
- [Streaming in Composed Agents](#streaming-in-composed-agents)
- [Best Practices](#best-practices)

## Enabling Streaming

Set `enableStreaming: true` on any agent:

```typescript
import { Agent } from "@opperai/agents";
import { z } from "zod";

const agent = new Agent({
  name: "StreamingAgent",
  instructions: "Answer questions thoroughly.",
  enableStreaming: true,
  outputSchema: z.object({ answer: z.string() }),
});

const { result } = await agent.run("Explain how neural networks work");
```

## Stream Callbacks

Handle streaming events with callbacks on the agent:

```typescript
const agent = new Agent({
  name: "StreamingAgent",
  instructions: "Answer questions.",
  enableStreaming: true,
  outputSchema: z.object({ answer: z.string() }),
  onStreamStart: ({ callType }) => {
    console.log(`\n[stream:start] ${callType}`);
  },
  onStreamChunk: ({ callType, delta, accumulated, jsonPath }) => {
    if (callType === "final_result") {
      process.stdout.write(delta ?? "");
    }
  },
  onStreamEnd: ({ callType }) => {
    console.log(`\n[stream:end] ${callType}`);
  },
  onStreamError: ({ error }) => {
    console.error(`[stream:error] ${error.message}`);
  },
});
```

## Call Types

Streams distinguish between reasoning and final output:

- **`"think"`**: The agent's internal reasoning (tool selection, planning)
- **`"final_result"`**: The final answer being generated

```typescript
onStreamChunk: ({ callType, delta, accumulated }) => {
  if (callType === "think") {
    // Agent is reasoning — show in debug mode
    console.debug(`[think] ${delta}`);
  } else if (callType === "final_result") {
    // Final output — show to user
    process.stdout.write(delta ?? "");
  }
},
```

## Hook-Based Streaming

Use hooks for more flexible event handling:

```typescript
import { HookEvents } from "@opperai/agents";

agent.registerHook(HookEvents.StreamStart, ({ callType }) => {
  console.log(`Stream started: ${callType}`);
});

agent.registerHook(HookEvents.StreamChunk, ({ chunkData, accumulated }) => {
  if (chunkData.callType === "think" && chunkData.fieldBuffers?.reasoning) {
    console.debug(chunkData.fieldBuffers.reasoning);
  }
});

agent.registerHook(HookEvents.StreamEnd, ({ callType }) => {
  console.log(`Stream ended: ${callType}`);
});

agent.registerHook(HookEvents.StreamError, ({ error }) => {
  console.error(`Stream error: ${error}`);
});
```

## Event Emitter Pattern

Subscribe and unsubscribe dynamically:

```typescript
agent.on(HookEvents.StreamChunk, ({ chunkData, accumulated }) => {
  if (chunkData.callType === "final_result") {
    process.stdout.write(accumulated);
  }
});
```

## Chunk Data Structure

Each stream chunk contains:

```typescript
interface StreamChunkPayload {
  callType: "think" | "final_result";
  delta?: string;           // New text in this chunk
  accumulated?: string;     // Full text so far
  jsonPath?: string;        // JSON path being populated (for structured output)
  fieldBuffers?: Record<string, string>; // Per-field accumulated content
}
```

## Streaming with Structured Output

When using `outputSchema`, chunks arrive field by field:

```typescript
const agent = new Agent({
  name: "Analyzer",
  enableStreaming: true,
  outputSchema: z.object({
    summary: z.string(),
    topics: z.array(z.string()),
    sentiment: z.enum(["positive", "negative", "neutral"]),
  }),
  onStreamChunk: ({ jsonPath, delta }) => {
    // jsonPath tells you which field is being populated
    // e.g., "summary", "topics[0]", "sentiment"
    console.log(`[${jsonPath}] ${delta}`);
  },
});
```

## Web Server Integration (Express)

Stream agent responses to HTTP clients:

```typescript
import express from "express";
import { Agent } from "@opperai/agents";
import { z } from "zod";

const app = express();

app.get("/ask", async (req, res) => {
  const { question } = req.query;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const agent = new Agent({
    name: "QAAgent",
    instructions: "Answer the question.",
    enableStreaming: true,
    outputSchema: z.object({ answer: z.string() }),
    onStreamChunk: ({ callType, delta }) => {
      if (callType === "final_result" && delta) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
    },
  });

  await agent.run(question as string);
  res.write("data: [DONE]\n\n");
  res.end();
});
```

## Streaming in Composed Agents

Only the top-level coordinator streams to the user:

```typescript
const coordinator = new Agent({
  name: "Coordinator",
  instructions: "Delegate and synthesize.",
  tools: [researchAgent.asTool("research")],
  enableStreaming: true,
  onStreamChunk: ({ callType, delta }) => {
    if (callType === "final_result") {
      process.stdout.write(delta ?? "");
    }
  },
});
```

Child agents run without streaming (their results arrive as tool results).

## Best Practices

- **Use `callType` filtering**: Only show `"final_result"` to users; use `"think"` for debugging
- **Flush output**: Use `process.stdout.write` (not `console.log`) to avoid extra newlines
- **Error handling**: Always register `onStreamError` or `StreamError` hooks
- **SSE format**: For web servers, use `text/event-stream` with `data:` prefixed messages
- **Accumulated vs delta**: Use `delta` for incremental display, `accumulated` for full state
- **JSON path tracking**: Use `jsonPath` to build progressive UI updates for structured output
- **Clean termination**: Send a `[DONE]` signal to clients when the stream ends
