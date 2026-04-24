# Multi-Agent Composition Reference (Node Agents)

Build complex systems by using agents as tools within other agents. This enables delegation, specialization, and hierarchical reasoning.

## Contents
- [Basic Composition with asTool()](#basic-composition-with-astool)
- [How Composition Works](#how-composition-works)
- [Custom Tool Names](#custom-tool-names)
- [Multiple Specialist Agents](#multiple-specialist-agents)
- [Manual Tool Wrapping](#manual-tool-wrapping)
- [Usage Aggregation](#usage-aggregation)
- [Multi-Level Hierarchies](#multi-level-hierarchies)
- [Tracing Composed Agents](#tracing-composed-agents)
- [Streaming in Composed Agents](#streaming-in-composed-agents)
- [Best Practices](#best-practices)

## Basic Composition with asTool()

Use `agent.asTool()` to convert an agent into a tool:

```typescript
import { Agent, createFunctionTool } from "@opperai/agents";
import { z } from "zod";

const add = createFunctionTool(
  (input: { a: number; b: number }) => input.a + input.b,
  { name: "add", schema: z.object({ a: z.number(), b: z.number() }) },
);

const multiply = createFunctionTool(
  (input: { a: number; b: number }) => input.a * input.b,
  { name: "multiply", schema: z.object({ a: z.number(), b: z.number() }) },
);

// Specialist agent
const mathAgent = new Agent<string, { answer: number }>({
  name: "MathAgent",
  instructions: "Solve math problems step by step.",
  tools: [add, multiply],
  outputSchema: z.object({ answer: z.number() }),
});

// Coordinator uses the specialist
const coordinator = new Agent<string, string>({
  name: "Coordinator",
  instructions: "Delegate math problems to the math specialist.",
  tools: [mathAgent.asTool("math")],
});

const { result, usage } = await coordinator.run("What is (5 + 3) * 7?");
// usage includes aggregated stats from the child MathAgent
```

## How Composition Works

1. The parent agent decides to call a child agent (via `asTool()`)
2. The child agent receives input and runs its own think-act loop
3. The child returns its final result to the parent
4. The parent continues its reasoning with the result

Each child runs independently with its own tools, model, and iteration limit.

## Custom Tool Names and Descriptions

Provide a custom name and optional description when creating the tool:

```typescript
const coordinator = new Agent<string, string>({
  name: "Coordinator",
  tools: [
    mathAgent.asTool("calculate"),                              // Custom name only
    mathAgent.asTool("calculate", "Solve arithmetic problems"), // Name + description
    researchAgent.asTool("research", "Look up facts online"),   // Name + description
  ],
});
```

The `asTool(toolName, toolDescription?)` method accepts:
- `toolName` (required): The name the coordinator sees for this tool
- `toolDescription` (optional): Helps the coordinator understand when to use this agent

## Multiple Specialist Agents

```typescript
const researchAgent = new Agent<string, { answer: string }>({
  name: "ResearchAgent",
  instructions: "Answer factual questions by searching.",
  tools: [searchWeb, fetchUrl],
  outputSchema: z.object({ answer: z.string() }),
});

const writingAgent = new Agent<string, { content: string }>({
  name: "WritingAgent",
  instructions: "Write clear, concise content.",
  outputSchema: z.object({ content: z.string() }),
});

const codingAgent = new Agent<string, { code: string }>({
  name: "CodingAgent",
  instructions: "Write TypeScript code.",
  tools: [runCode],
  outputSchema: z.object({ code: z.string() }),
});

const coordinator = new Agent<string, string>({
  name: "ProjectManager",
  instructions: `You manage specialists:
    - research: finds information
    - writer: creates content
    - coder: writes code
    Delegate tasks appropriately.`,
  tools: [
    researchAgent.asTool("research"),
    writingAgent.asTool("writer"),
    codingAgent.asTool("coder"),
  ],
});
```

## Manual Tool Wrapping

For more control, wrap agents manually with `createFunctionTool`:

```typescript
const askResearcher = createFunctionTool(
  async (input: { question: string }) => {
    const agent = new Agent<string, { answer: string }>({
      name: "Researcher",
      instructions: "Research thoroughly.",
      tools: [searchWeb],
      outputSchema: z.object({ answer: z.string() }),
      model: "anthropic/claude-4-sonnet",
    });
    const { result } = await agent.run(input.question);
    return ToolResultFactory.success(result.answer);
  },
  {
    name: "ask_researcher",
    description: "Ask the research specialist to investigate a topic",
    schema: z.object({ question: z.string() }),
  },
);
```

## Usage Aggregation

When using `asTool()`, usage stats are automatically aggregated:

```typescript
const { result, usage } = await coordinator.run("Research and summarize AI trends");

console.log(usage);
// {
//   requests: 5,        // Total LLM calls (parent + children)
//   inputTokens: 12000, // Total across all agents
//   outputTokens: 3000,
//   totalTokens: 15000,
// }
```

## Multi-Level Hierarchies

Agents can be nested multiple levels:

```typescript
// Level 3
const calculator = new Agent({ name: "Calculator", tools: [add, multiply] });

// Level 2
const mathDept = new Agent({
  name: "MathDept",
  tools: [calculator.asTool("calculate")],
});

// Level 1
const ceo = new Agent({
  name: "CEO",
  tools: [mathDept.asTool("math_department")],
});
```

## Tracing Composed Agents

Each child creates spans as children of the parent's span:

```
Trace: "Coordinator"
├── Think: "I need to solve the math problem"
├── Tool: "math" → triggers MathAgent
│   ├── Think: "I'll use add then multiply"
│   ├── Tool: "add(5, 3)" → 8
│   └── Tool: "multiply(8, 7)" → 56
└── Final: "The answer is 56"
```

## Streaming in Composed Agents

Enable streaming on the coordinator for real-time output:

```typescript
const coordinator = new Agent<string, string>({
  name: "Coordinator",
  instructions: "Delegate and synthesize.",
  tools: [researchAgent.asTool("research")],
  enableStreaming: true,
  onStreamChunk: ({ accumulated }) => {
    process.stdout.write(accumulated);
  },
});
```

## Best Practices

- **Clear descriptions**: Each agent needs a clear purpose so the coordinator can delegate
- **Single responsibility**: One area of expertise per agent
- **Limit depth**: 2-3 levels is usually sufficient
- **Model selection**: Use cheaper models for simple specialists, powerful ones for coordinators
- **Error handling**: Child failures appear as tool errors to the parent
- **Limit iterations**: Set `maxIterations` on child agents
- **Use `asTool()`**: Prefer over manual wrapping for automatic usage aggregation
- **Meaningful names**: The `asTool("name")` parameter helps the coordinator understand capabilities
