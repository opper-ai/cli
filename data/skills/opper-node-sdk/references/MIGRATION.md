# Migrating from OpenRouter (Node SDK)

Replace OpenAI-compatible API calls through OpenRouter with Opper's native TypeScript/Node SDK.

## Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Basic Chat Completion → Task Completion](#basic-chat-completion--task-completion)
- [Structured Output](#structured-output)
- [Streaming](#streaming)
- [Model Selection and Fallbacks](#model-selection-and-fallbacks)
- [Knowledge Bases (RAG)](#knowledge-bases-rag)
- [Key Differences](#key-differences)
- [What You Gain](#what-you-gain)
- [Common Gotchas](#common-gotchas)

## Overview

OpenRouter provides an OpenAI-compatible gateway to multiple LLM providers. Opper replaces the low-level chat completions API with a task-oriented `opper.call()` interface that handles structured output, tracing, and knowledge retrieval natively.

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
import { Opper } from "opperai";

const opper = new Opper({
  httpBearer: process.env["OPPER_HTTP_BEARER"] ?? "",
});
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

**Opper:**
```typescript
const result = await opper.call({
  name: "summarize",
  instructions: "Summarize the text.",
  input: articleText,
});
const summary = result.message;
```

The `name` parameter identifies the task for tracing and versioning. Instructions replace the system message; input replaces the user message.

## Structured Output

**OpenRouter:**
```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [
    { role: "system", content: "Extract entities from the ticket." },
    { role: "user", content: ticket },
  ],
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

**Opper:**
```typescript
const result = await opper.call({
  name: "extract_entities",
  instructions: "Extract entities from the ticket.",
  input: ticket,
  outputSchema: {
    type: "object",
    properties: {
      customer_name: { type: "string" },
      issue_type: { type: "string" },
    },
    required: ["customer_name", "issue_type"],
  },
});
const entities = result.jsonPayload as { customer_name: string; issue_type: string };
```

Key change: pass a JSON Schema object to `outputSchema`. The result is auto-parsed into `result.jsonPayload`. No `JSON.parse()` needed. You can also use Zod schemas for type-safe validation on the client side.

## Streaming

**OpenRouter:**
```typescript
const stream = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [
    { role: "system", content: "Write a story." },
    { role: "user", content: "A robot learning to cook" },
  ],
  stream: true,
});
for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta?.content;
  if (delta) process.stdout.write(delta);
}
```

**Opper:**
```typescript
const outer = await opper.stream({
  name: "write_story",
  instructions: "Write a story.",
  input: "A robot learning to cook",
});

const stream = outer.result;

for await (const event of stream) {
  const delta = event.data?.delta;
  if (delta) process.stdout.write(delta);
}
```

Use `opper.stream()` instead of `opper.call()`. Access the stream via `outer.result`, then iterate with `for await`.

## Model Selection and Fallbacks

**OpenRouter:**
```typescript
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [...],
  ...(({
    models: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
    ],
  }) as any),
});
```

**Opper:**
```typescript
const result = await opper.call({
  name: "my_task",
  instructions: "...",
  input: "...",
  model: [
    "anthropic/claude-sonnet-4",
    "openai/gpt-4o",
    "google/gemini-2.0-flash",
  ],
});
```

Pass an array to `model` for automatic fallback. Opper tries each model in order. Works with both `opper.call()` and `opper.stream()`.

## Knowledge Bases (RAG)

OpenRouter RAG requires manual embedding, vector storage, and retrieval. Opper provides managed knowledge bases.

**OpenRouter (manual RAG):**
```typescript
// 1. Generate embeddings
const embedResp = await client.embeddings.create({
  model: "openai/text-embedding-3-small",
  input: [query, ...documents],
});
// 2. Compute cosine similarity manually
// 3. Select top-k results
// 4. Pass context to completion
const response = await client.chat.completions.create({
  model: "anthropic/claude-sonnet-4",
  messages: [
    { role: "system", content: "Answer using the context." },
    { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
  ],
});
```

**Opper (managed RAG):**
```typescript
// 1. Create a knowledge base (one-time setup)
const kb = await opper.knowledge.create({
  name: `my_kb_${Date.now()}`,
});

// 2. Add documents
await opper.knowledge.add(kb.id, {
  key: "refund_policy",
  content: "Document text here...",
  metadata: { category: "billing" },
});

// 3. Query — returns ranked results with scores
const results = await opper.knowledge.query(kb.id, {
  query: "How do refunds work?",
  topK: 3,
});

// 4. Use results as context
const context = results.map((r) => r.content).join("\n");
const answer = await opper.call({
  name: "rag_answer",
  instructions: "Answer using the provided context.",
  input: `Context:\n${context}\n\nQuestion: How do refunds work?`,
});
```

No embedding model selection, vector math, or storage management needed.

## Key Differences

| Concept | OpenRouter | Opper |
|---------|-----------|-------|
| Client | `new OpenAI({ baseURL: ... })` | `new Opper({ httpBearer: ... })` |
| Completion | `client.chat.completions.create()` | `opper.call()` |
| System message | `messages[0].role = "system"` | `instructions` parameter |
| User message | `messages[1].role = "user"` | `input` parameter |
| Structured output | `response_format.json_schema` | `outputSchema` object |
| Parse response | `JSON.parse(message.content!)` | `result.jsonPayload` |
| Plain text | `message.content` | `result.message` |
| Streaming | `stream: true` on create | `opper.stream()` |
| Model fallback | `extra_body models` (cast to any) | `model: [...]` |
| Embeddings / RAG | Manual: embed → cosine → top-k | `opper.knowledge.create/add/query` |
| Tracing | Not built-in | `parentSpanId` on every call |
| Tool calling | `tools` + `tool_calls` loop | Use `outputSchema` or agent SDK |

## What You Gain

- **No JSON parsing** — structured output is auto-parsed into `jsonPayload`
- **Managed RAG** — knowledge bases handle embedding, indexing, and retrieval
- **Built-in tracing** — every call returns a `spanId`; link calls with `parentSpanId`
- **Model fallbacks** — first-class `model: [...]` parameter
- **Task naming** — `name` parameter enables versioning, A/B testing, and analytics
- **Cost tracking** — `result.usage` and `result.cost` on every call

## Common Gotchas

- **Verify model IDs before using them.** Opper model identifiers differ from OpenRouter's (e.g., `gcp/gemini-2.5-flash-eu` not `google/gemini-2.5-flash-lite`). Check available models at https://api.opper.ai/static/data/language_models.json or https://docs.opper.ai/capabilities/models to avoid model-not-found errors.
- Use `result.jsonPayload` (not `result.message`) when `outputSchema` is set — `message` will be `null`
- Use `result.message` (not `result.jsonPayload`) when no `outputSchema` is set
- The `name` parameter is required and should use `/` separators for namespacing (e.g., `"support/extract_entities"`)
- Access the stream via `outer.result` (not `outer` directly) after calling `opper.stream()`
- Knowledge base `add()` takes `(kbId, { key, content, metadata })` — the `key` must be unique within the base
- All parameters use camelCase (`outputSchema`, `parentSpanId`, `httpBearer`, `jsonPayload`, `topK`)
