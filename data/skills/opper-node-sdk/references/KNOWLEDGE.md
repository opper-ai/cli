# Knowledge Bases Reference (Node SDK)

Knowledge bases provide semantic search over your documents using vector embeddings. Use them for RAG (Retrieval-Augmented Generation) pipelines.

## Contents
- [Creating a Knowledge Base](#creating-a-knowledge-base)
- [Adding Documents](#adding-documents)
- [Querying (Semantic Search)](#querying-semantic-search)
- [Query with Filters](#query-with-filters)
- [RAG Pattern: Query + Call](#rag-pattern-query--call)
- [Listing Knowledge Bases](#listing-knowledge-bases)
- [Getting a Knowledge Base](#getting-a-knowledge-base)
- [File Upload](#file-upload)
- [Deleting Documents](#deleting-documents)
- [Deleting a Knowledge Base](#deleting-a-knowledge-base)
- [Best Practices](#best-practices)

## Creating a Knowledge Base

```typescript
import { Opper } from "opperai";

const opper = new Opper({
  httpBearer: process.env["OPPER_HTTP_BEARER"] ?? "",
});

const kb = await opper.knowledge.create({
  name: "support_docs",
});
```

## Adding Documents

```typescript
await opper.knowledge.add(kb.id, {
  content: "To reset your password, click 'Forgot Password' on the login page.",
  key: "doc_001",  // optional
  metadata: { category: "auth", source: "helpdesk" },
});

// Add multiple documents
const docs = [
  {
    key: "doc_002",
    content: "Billing cycles run on the 1st of each month.",
    metadata: { category: "billing" },
  },
  {
    key: "doc_003",
    content: "To upgrade your plan, go to Settings > Subscription.",
    metadata: { category: "account" },
  },
];

for (const doc of docs) {
  await opper.knowledge.add(kb.id, doc);
}
```

## Querying (Semantic Search)

```typescript
const results = await opper.knowledge.query(kb.id, {
  query: "How do I change my password?",
  topK: 3,
});

for (const result of results) {
  console.log(`Score: ${result.score.toFixed(3)}`);
  console.log(`Content: ${result.content}`);
  console.log(`Metadata: ${JSON.stringify(result.metadata)}`);
}
```

## Query with Filters

```typescript
// Filters use array of { field, operation, value } objects
const results = await opper.knowledge.query(kb.id, {
  query: "billing question",
  topK: 5,
  filters: [{ field: "category", operation: "=", value: "billing" }],
});
```

## RAG Pattern: Query + Call

Combine knowledge base retrieval with task completion:

```typescript
async function answerWithContext(question: string) {
  // 1. Retrieve relevant context
  const results = await opper.knowledge.query(kb.id, {
    query: question,
    topK: 3,
  });

  // 2. Build context string
  const context = results
    .map((r) => `[${r.metadata?.source ?? "unknown"}]: ${r.content}`)
    .join("\n");

  // 3. Call with context
  const result = await opper.call({
    name: "answer_with_rag",
    instructions: "Answer the question using only the provided context. Cite sources.",
    input: `Context:\n${context}\n\nQuestion: ${question}`,
    outputSchema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        sources: { type: "array", items: { type: "string" } },
      },
      required: ["answer", "sources"],
    },
  });

  return result.jsonPayload;
}
```

## Listing Knowledge Bases

```typescript
const knowledgeBases = await opper.knowledge.list();
for (const kb of knowledgeBases) {
  console.log(`${kb.name}: ${kb.id}`);
}
```

## Getting a Knowledge Base

```typescript
// By ID (pass string directly, not object)
const kb = await opper.knowledge.get("kb_123");

// By name (pass string directly, not object)
const kb = await opper.knowledge.getByName("support_docs");
```

## File Upload

Upload files (PDF, DOCX, etc.) for automatic processing:

```typescript
// Get upload URL
const uploadInfo = await opper.knowledge.getUploadUrl({
  id: kb.id,
  filename: "manual.pdf",
});

// Upload the file
await fetch(uploadInfo.url, {
  method: "PUT",
  body: fileBuffer,
});

// Register the upload
await opper.knowledge.registerFileUpload({
  id: kb.id,
  uploadId: uploadInfo.uploadId,
  filename: "manual.pdf",
});
```

## Deleting Documents

```typescript
// Pass knowledgeBaseId and fileId as separate string params
await opper.knowledge.deleteFile(kb.id, "file_123");
```

## Deleting a Knowledge Base

```typescript
// Pass string directly, not object
await opper.knowledge.delete(kb.id);
```

## Best Practices

- Use meaningful `key` values for document management
- Keep documents focused — one topic per document
- Add `metadata` for filtering (category, source, date)
- Use `topK: 3` to `topK: 5` for most queries
- Update documents by re-adding with the same `key`
- Use `parentSpanId` in calls for tracing RAG pipelines
