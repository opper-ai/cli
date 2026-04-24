# Tools Reference (Node Agents)

Tools give agents capabilities to interact with the world. Define tools with `createFunctionTool` or the `@tool` decorator class pattern.

## Contents
- [createFunctionTool](#createfunctiontool)
- [Tool with Complex Schema](#tool-with-complex-schema)
- [ToolResultFactory](#toolresultfactory)
- [Async Tools](#async-tools)
- [Class-Based @tool Decorator](#class-based-tool-decorator)
- [Class with Async Methods](#class-with-async-methods)
- [Using Tools with Agents](#using-tools-with-agents)
- [Tool Return Values](#tool-return-values)
- [Zod Schema Features](#zod-schema-features)
- [Best Practices](#best-practices)

## createFunctionTool

The primary way to define tools with Zod schema validation:

```typescript
import { createFunctionTool } from "@opperai/agents";
import { z } from "zod";

const searchWeb = createFunctionTool(
  async (input: { query: string; maxResults?: number }) => {
    // Your implementation
    return [{ title: "Result", url: "https://example.com" }];
  },
  {
    name: "search_web",
    description: "Search the web for information",
    schema: z.object({
      query: z.string().describe("The search query"),
      maxResults: z.number().optional().default(5),
    }),
  },
);
```

## Tool with Complex Schema

```typescript
const sendEmail = createFunctionTool(
  async (input: { to: string; subject: string; body: string; cc?: string[] }) => {
    // Send email logic
    return { success: true, messageId: "msg_123" };
  },
  {
    name: "send_email",
    description: "Send an email to the specified recipient",
    schema: z.object({
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Email body content"),
      cc: z.array(z.string().email()).optional().describe("CC recipients"),
    }),
  },
);
```

## ToolResultFactory

Use `ToolResultFactory` for explicit success/failure results:

```typescript
import { createFunctionTool, ToolResultFactory } from "@opperai/agents";
import { z } from "zod";

const divide = createFunctionTool(
  (input: { a: number; b: number }) => {
    if (input.b === 0) {
      return ToolResultFactory.failure("Cannot divide by zero");
    }
    return ToolResultFactory.success(input.a / input.b);
  },
  {
    name: "divide",
    description: "Divide two numbers",
    schema: z.object({ a: z.number(), b: z.number() }),
  },
);
```

## Async Tools

All tools can be async for I/O operations:

```typescript
const fetchUrl = createFunctionTool(
  async (input: { url: string }) => {
    const response = await fetch(input.url);
    if (!response.ok) {
      return ToolResultFactory.failure(`HTTP ${response.status}`);
    }
    const text = await response.text();
    return ToolResultFactory.success(text.slice(0, 2000));
  },
  {
    name: "fetch_url",
    description: "Fetch the content of a URL",
    schema: z.object({ url: z.string().url() }),
  },
);
```

## Class-Based @tool Decorator

Group related tools in a class:

```typescript
import { tool, extractTools } from "@opperai/agents";
import { z } from "zod";

class MathTools {
  @tool({ schema: z.object({ a: z.number(), b: z.number() }) })
  add({ a, b }: { a: number; b: number }) {
    return a + b;
  }

  @tool({ schema: z.object({ a: z.number(), b: z.number() }) })
  multiply({ a, b }: { a: number; b: number }) {
    return a * b;
  }

  @tool({ schema: z.object({ expression: z.string() }) })
  evaluate({ expression }: { expression: string }) {
    // Safe expression evaluation
    return Function(`"use strict"; return (${expression})`)();
  }
}

// Extract tools from the class instance
const mathTools = extractTools(new MathTools());
```

## Class with Async Methods

```typescript
class ApiTools {
  @tool({
    schema: z.object({
      city: z.string().describe("City name"),
      unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
    }),
  })
  async get_weather({ city, unit }: { city: string; unit: string }) {
    const response = await fetch(`https://api.weather.com/v1/${city}?unit=${unit}`);
    return response.json();
  }

  @tool({ schema: z.object({ query: z.string() }) })
  async search_database({ query }: { query: string }) {
    // Database query logic
    return [{ id: 1, name: "Result" }];
  }
}

const apiTools = extractTools(new ApiTools());
```

## Using Tools with Agents

```typescript
import { Agent } from "@opperai/agents";

const agent = new Agent<string, { answer: string }>({
  name: "ResearchBot",
  instructions: "Use tools to research and answer questions.",
  tools: [searchWeb, fetchUrl, ...mathTools],
  outputSchema: z.object({ answer: z.string() }),
  maxIterations: 10,
});

const { result } = await agent.run("What is the population of Tokyo?");
```

## Tool Return Values

Tools can return various types — they're serialized to JSON for the LLM:

```typescript
// Return a primitive
const getCount = createFunctionTool(
  () => 42,
  { name: "get_count", schema: z.object({}) },
);

// Return an object
const getData = createFunctionTool(
  () => ({ key: "value", items: [1, 2, 3] }),
  { name: "get_data", schema: z.object({}) },
);

// Return with ToolResultFactory for explicit control
const riskyOp = createFunctionTool(
  async (input: { id: string }) => {
    try {
      const data = await fetchData(input.id);
      return ToolResultFactory.success(data);
    } catch (e) {
      return ToolResultFactory.failure(`Failed to fetch: ${e.message}`);
    }
  },
  { name: "risky_op", schema: z.object({ id: z.string() }) },
);
```

## Zod Schema Features

Leverage Zod's full type system:

```typescript
const complexTool = createFunctionTool(
  (input) => { /* ... */ },
  {
    name: "complex_tool",
    schema: z.object({
      // Enums
      mode: z.enum(["fast", "accurate", "balanced"]),
      // Optional with defaults
      limit: z.number().min(1).max(100).default(10),
      // Nested objects
      filters: z.object({
        category: z.string().optional(),
        minScore: z.number().optional(),
      }).optional(),
      // Arrays
      tags: z.array(z.string()).max(5),
      // Unions
      id: z.union([z.string(), z.number()]),
    }),
  },
);
```

## Best Practices

- **Clear names**: Use `verb_noun` format: `search_web`, `get_weather`, `send_email`
- **Descriptive schemas**: Use `.describe()` on Zod fields — the LLM reads these
- **Error handling**: Use `ToolResultFactory.failure()` for expected errors, throw for unexpected ones
- **Focused tools**: Each tool should do one thing well
- **Async for I/O**: Always use async for network, database, or file operations
- **Schema validation**: Let Zod validate inputs — don't repeat validation in the function
- **Limit tools**: 5-10 per agent. Use composition for more capabilities
- **Type safety**: The Zod schema ensures both compile-time and runtime type safety
