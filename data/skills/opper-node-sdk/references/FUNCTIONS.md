# Functions Reference (Node SDK)

Functions are server-side managed task definitions that allow you to version, reuse, and monitor AI tasks at scale.

## Contents
- [Why Use Functions?](#why-use-functions)
- [Creating Functions](#creating-functions)
- [Calling Functions](#calling-functions)
- [Listing Functions](#listing-functions)
- [Getting a Function](#getting-a-function)
- [Updating Functions](#updating-functions)
- [Deleting Functions](#deleting-functions)
- [Function Revisions](#function-revisions)
- [Streaming a Function](#streaming-a-function)
- [Inline vs. Managed Functions](#inline-vs-managed-functions)
- [Best Practices](#best-practices)

## Why Use Functions?

- **Versioning**: Track changes to instructions and schemas over time
- **Reusability**: Call the same function from multiple places
- **Monitoring**: Dashboard visibility into usage and performance
- **Revisions**: Compare different versions of instructions or models

## Creating Functions

```typescript
import { Opper } from "opperai";

const opper = new Opper({
  httpBearer: process.env["OPPER_HTTP_BEARER"] ?? "",
});

const fn = await opper.functions.create({
  name: "classify_support_ticket",
  instructions: "Classify the support ticket into a category",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The ticket text" },
    },
    required: ["text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["billing", "technical", "account", "general"],
      },
      confidence: { type: "number" },
    },
    required: ["category", "confidence"],
  },
});
```

## Calling Functions

Once created, call functions by name:

```typescript
const result = await opper.call({
  name: "classify_support_ticket",
  input: { text: "I was charged twice for my subscription" },
});

console.log(result.jsonPayload);
// { category: "billing", confidence: 0.95 }
```

## Listing Functions

```typescript
const functions = await opper.functions.list();
for (const fn of functions) {
  console.log(`${fn.name}: ${fn.description}`);
}
```

## Getting a Function

```typescript
// By ID
const fn = await opper.functions.get({ id: "fn_123" });

// By name
const fn = await opper.functions.getByName({ name: "classify_support_ticket" });
```

## Updating Functions

```typescript
await opper.functions.update({
  id: "fn_123",
  instructions: "Updated: Classify the ticket with detailed reasoning",
});
```

## Deleting Functions

```typescript
await opper.functions.delete({ id: "fn_123" });
```

## Function Revisions

List and call specific revisions:

```typescript
// List revisions
const revisions = await opper.functions.revisions.list({ functionId: "fn_123" });

// Get a specific revision
const rev = await opper.functions.getByRevision({
  id: "fn_123",
  revisionId: "rev_456",
});

// Call a specific revision
const result = await opper.functions.callRevision({
  id: "fn_123",
  revisionId: "rev_456",
  input: { text: "test input" },
});
```

## Streaming a Function

```typescript
const stream = await opper.functions.stream({
  id: "fn_123",
  input: { text: "Generate a long response" },
});

for await (const event of stream) {
  const delta = event.data?.delta;
  if (delta) {
    process.stdout.write(delta);
  }
}
```

## Inline vs. Managed Functions

When you call `opper.call()` with a `name` that doesn't exist, Opper auto-creates the function. This is useful for prototyping:

```typescript
// Auto-creates "my_new_task" if it doesn't exist
const result = await opper.call({
  name: "my_new_task",
  instructions: "Do something useful",
  input: "hello",
});
```

For production, explicitly create and version functions.

## Best Practices

- Use descriptive names with namespacing: `"team/component/task"`
- Always provide both `inputSchema` and `outputSchema`
- Use `tags` for cost attribution and dashboard filtering
- Use revisions for A/B testing different instructions or models
- Keep function names stable for consistent dashboard tracking
