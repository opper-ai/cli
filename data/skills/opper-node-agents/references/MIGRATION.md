# Migrating from OpenRouter (Node Agent SDK)

Replace OpenRouter tool/function calling patterns with Opper's TypeScript agent framework for autonomous multi-step workflows.

## Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Basic Chat Completion → Task Completion](#basic-chat-completion--task-completion)
- [Structured Output](#structured-output)
- [Streaming](#streaming)
- [Model Selection and Fallbacks](#model-selection-and-fallbacks)
- [Tool Calling → Agent Tools](#tool-calling--agent-tools)
- [Key Differences](#key-differences)
- [What You Gain](#what-you-gain)
- [Common Gotchas](#common-gotchas)

## Overview

OpenRouter provides OpenAI-compatible tool/function calling where you manually manage the tool call loop (send tools, parse tool_calls, execute functions, send results back). Opper's agent SDK replaces this with declarative tool definitions using Zod schemas and an autonomous `agent.run()` loop that handles multi-step reasoning automatically.

## Authentication

**OpenRouter:**
```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: "sk-or-...",
});
```

**Opper:**
```typescript
// Agent SDK uses OPPER_HTTP_BEARER from environment automatically
process.env["OPPER_HTTP_BEARER"] = "your-key";
```

## Basic Chat Completion → Task Completion

**OpenRouter:**
```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [
    { role: "system", content: "Summarize the text." },
    { role: "user", content: articleText },
  ],
});
const summary = response.choices[0].message.content;
```

**Opper (agent for simple tasks):**
```typescript
import { Agent } from "@opperai/agents";

const agent = new Agent({
  name: "Summarizer",
  instructions: "Summarize the text.",
});
const { result } = await agent.run(articleText);
```

## Structured Output

**OpenRouter:**
```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [...],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "ticket_entities",
      strict: true,
      schema: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          issue_type: { type: "string" },
        },
        required: ["customer_name", "issue_type"],
        additionalProperties: false,
      },
    },
  },
});
const entities = JSON.parse(response.choices[0].message.content!);
```

**Opper (Zod schema):**
```typescript
import { Agent } from "@opperai/agents";
import { z } from "zod";

const TicketEntities = z.object({
  customer_name: z.string().describe("Customer's full name"),
  issue_type: z.string().describe("Type of issue reported"),
});

const agent = new Agent({
  name: "EntityExtractor",
  instructions: "Extract entities from the support ticket.",
  outputSchema: TicketEntities,
});

const { result } = await agent.run(ticket);
console.log(result.customer_name); // Typed access
```

The agent returns a validated, typed object matching the Zod schema.

## Streaming

Enable streaming on the agent for real-time output:

```typescript
const agent = new Agent({
  name: "Writer",
  instructions: "Write a story.",
  enableStreaming: true,
});
const { result } = await agent.run("A robot learning to cook");
```

## Model Selection and Fallbacks

**OpenRouter:**
```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [...],
  ...({ models: ["anthropic/claude-sonnet-4", "openai/gpt-4o"] } as any),
});
```

**Opper:**
```typescript
const agent = new Agent({
  name: "MyAgent",
  instructions: "...",
  model: "anthropic/claude-sonnet-4",
});
```

Set the `model` parameter on the Agent constructor.

## Tool Calling → Agent Tools

This is the biggest change. OpenRouter requires you to manually manage the tool call loop. Opper agents handle it automatically.

**OpenRouter (manual tool loop):**
```typescript
const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "route_ticket",
      description: "Route a ticket to a team.",
      parameters: {
        type: "object",
        properties: {
          team: { type: "string" },
          priority: { type: "string" },
        },
        required: ["team", "priority"],
      },
    },
  },
];

const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  { role: "system", content: "Help the user. Use tools as needed." },
  { role: "user", content: userInput },
];

while (true) {
  const response = await client.chat.completions.create({
    model: "anthropic/claude-sonnet-4",
    messages,
    tools,
  });

  const msg = response.choices[0].message;
  if (!msg.tool_calls?.length) break;

  messages.push(msg);
  for (const toolCall of msg.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments);
    let result: string;
    if (toolCall.function.name === "get_weather") {
      result = getWeatherImpl(args.city);
    } else if (toolCall.function.name === "route_ticket") {
      result = routeTicketImpl(args.team, args.priority);
    }
    messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: result!,
    });
  }
}
```

**Opper (declarative tools + autonomous loop):**
```typescript
import { Agent, createFunctionTool } from "@opperai/agents";
import { z } from "zod";

const getWeather = createFunctionTool(
  (input: { city: string }) => `Weather in ${input.city}: 22°C, sunny`,
  {
    name: "get_weather",
    description: "Get weather for a city.",
    schema: z.object({ city: z.string() }),
  }
);

const routeTicket = createFunctionTool(
  (input: { team: string; priority: string }) =>
    `Routed to ${input.team} with ${input.priority} priority`,
  {
    name: "route_ticket",
    description: "Route a ticket to a team.",
    schema: z.object({
      team: z.string(),
      priority: z.string(),
    }),
  }
);

const agent = new Agent({
  name: "SupportAgent",
  instructions: "Help the user. Use tools as needed.",
  tools: [getWeather, routeTicket],
  maxIterations: 10,
});

const { result } = await agent.run(userInput);
```

The agent runs the tool loop autonomously — calling tools, collecting results, and reasoning until it reaches a final answer.

**Multi-tool agent with structured output:**
```typescript
import { Agent, createFunctionTool } from "@opperai/agents";
import { z } from "zod";

const TicketResolution = z.object({
  response: z.string(),
  team: z.string(),
  priority: z.string(),
});

const lookupCustomer = createFunctionTool(
  (input: { accountId: string }) =>
    `Customer: Jane Doe, Plan: Pro, Status: Active`,
  {
    name: "lookup_customer",
    description: "Look up customer details by account ID.",
    schema: z.object({ accountId: z.string() }),
  }
);

const checkBilling = createFunctionTool(
  (input: { accountId: string }) =>
    `Last charge: $49.99 on 2025-01-15, duplicate detected`,
  {
    name: "check_billing",
    description: "Check recent billing transactions for an account.",
    schema: z.object({ accountId: z.string() }),
  }
);

const agent = new Agent({
  name: "BillingAgent",
  instructions:
    "Investigate the billing issue using the available tools, " +
    "then provide a resolution with team routing.",
  tools: [lookupCustomer, checkBilling],
  outputSchema: TicketResolution,
});

const { result } = await agent.run(
  "Account AC-4821 was charged twice for Pro subscription"
);
console.log(`Route to: ${result.team} (${result.priority})`);
console.log(`Response: ${result.response}`);
```

## Key Differences

| Concept | OpenRouter | Opper Agent SDK |
|---------|-----------|----------------|
| Client | `new OpenAI({ baseURL: ... })` | `new Agent({ name, instructions })` |
| Tool definition | `tools` JSON array | `createFunctionTool()` with Zod schema |
| Tool dispatch | Manual while loop | Automatic via `agent.run()` |
| Tool arguments | `JSON.parse(toolCall.function.arguments)` | Passed as typed function params |
| Tool results | Push `{ role: "tool", ... }` message | Return value from function |
| Structured output | `response_format.json_schema` | `outputSchema: z.object({...})` |
| Parse response | `JSON.parse(message.content!)` | Typed result from `agent.run()` |
| Multi-step reasoning | Manual message accumulation | Automatic with `maxIterations` |
| Model selection | `model` string + `extra_body.models` | `model` on Agent constructor |

## What You Gain

- **No tool dispatch loop** — the agent handles tool calling, result collection, and multi-step reasoning
- **Type-safe tools** — Zod schemas provide compile-time type checking for tool inputs
- **Typed output** — structured results match the Zod schema type
- **Built-in tracing** — every agent run creates a trace with all tool calls visible
- **Iteration control** — `maxIterations` prevents runaway loops
- **Streaming** — enable with `enableStreaming: true`
- **Composability** — agents can call other agents for complex workflows

## Common Gotchas

- **Verify model IDs before using them.** Opper model identifiers differ from OpenRouter's (e.g., `gcp/gemini-2.5-flash-eu` not `google/gemini-2.5-flash-lite`). Check available models at https://api.opper.ai/static/data/language_models.json or https://docs.opper.ai/capabilities/models to avoid model-not-found errors.
- `agent.run()` is async — returns `Promise<{ result, usage }>`
- Tool functions receive a single typed input object, not positional arguments
- `createFunctionTool` requires a Zod schema — plain JSON Schema objects are not accepted
- `outputSchema` accepts a Zod schema, not a JSON Schema object (unlike the Node SDK's `opper.call()`)
- If you don't need multi-step tool calling, consider using `opper.call()` from the Node SDK with `outputSchema` instead
- The agent import is `@opperai/agents`, not `opperai`
