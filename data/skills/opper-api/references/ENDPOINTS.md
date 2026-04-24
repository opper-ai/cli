# Complete Endpoint Reference (Opper API)

All endpoints use base URL `https://api.opper.ai` and require `Authorization: Bearer $OPPER_API_KEY`.

## Contents
- [Task Completion](#task-completion)
- [Functions](#functions)
- [Knowledge Bases](#knowledge-bases)
- [Traces & Spans](#traces--spans)
- [Span Metrics](#span-metrics)
- [Datasets](#datasets)
- [Embeddings](#embeddings)
- [Models](#models)
- [Other Endpoints](#other-endpoints)
- [Common Response Patterns](#common-response-patterns)

## Task Completion

### POST /v2/call

Execute a task with optional structured output.

```json
{
  "name": "string (required)",
  "instructions": "string",
  "input": "any",
  "input_schema": "JSON Schema object",
  "output_schema": "JSON Schema object",
  "model": "string or string[]",
  "examples": [{"input": "any", "output": "any", "comment": "string"}],
  "parent_span_id": "UUID",
  "tags": {"key": "value"},
  "configuration": {
    "few_shot_count": "integer",
    "evaluate": "boolean"
  }
}
```

Response: `{span_id, message?, json_payload?, cached, usage, cost}`

### POST /v2/call/stream

Same request body as `/v2/call`. Returns SSE stream.

Each event: `{"delta": "string", "json_path": "string", "span_id": "UUID", "chunk_type": "text|json|error"}`

---

## Functions

### POST /v2/functions

Create a managed function.

```json
{
  "name": "string (required, pattern: alphanumeric with / . - _)",
  "description": "string",
  "instructions": "string (required)",
  "input_schema": "JSON Schema",
  "output_schema": "JSON Schema",
  "model": "string or string[]",
  "configuration": {"few_shot_count": 3}
}
```

Response: `{id, name, description, instructions, input_schema, output_schema, model, revision_id, dataset_id}`

### GET /v2/functions

List functions. Query params: `name`, `sort`, `offset`, `limit`.

Response: `{data: [...], meta: {total_count}}`

### GET /v2/functions/{id}

Get function by ID.

### GET /v2/functions/by-name/{name}

Get function by name (supports `/` in path).

### PATCH /v2/functions/{id}

Update function (creates new revision). Same fields as POST, all optional.

### DELETE /v2/functions/{id}

Soft-delete function.

### POST /v2/functions/{id}/call

Call a managed function.

```json
{
  "input": "any",
  "parent_span_id": "UUID",
  "examples": [...],
  "tags": {...}
}
```

### POST /v2/functions/{id}/call/stream

Stream a function call (SSE).

### GET /v2/functions/{id}/revisions

List function revisions. Query: `offset`, `limit`.

### GET /v2/functions/{id}/revisions/{revision_id}

Get specific revision.

### POST /v2/functions/{id}/call/{revision_id}

Call a specific revision.

### POST /v2/functions/{id}/call/stream/{revision_id}

Stream a specific revision.

---

## Knowledge Bases

### POST /v2/knowledge

Create knowledge base.

```json
{"name": "string (required)", "description": "string"}
```

### GET /v2/knowledge

List all knowledge bases.

### GET /v2/knowledge/{id}

Get knowledge base by ID.

### GET /v2/knowledge/by-name/{name}

Get by name.

### DELETE /v2/knowledge/{id}

Delete knowledge base.

### POST /v2/knowledge/{id}/add

Add document.

```json
{
  "key": "string (required, unique within index)",
  "content": "string (required)",
  "metadata": {"key": "value"}
}
```

### POST /v2/knowledge/{id}/query

Semantic search.

```json
{
  "query": "string (required)",
  "top_k": "integer (default: 5)"
}
```

Response: array of `{content, score, metadata, key}`

### GET /v2/knowledge/{id}/upload-url

Get pre-signed URL for file upload. Query: `filename`.

Response: `{url, upload_id}`

### POST /v2/knowledge/{id}/upload

Register uploaded file.

### GET /v2/knowledge/{id}/files

List files in knowledge base.

### DELETE /v2/knowledge/{id}/files/{file_id}

Delete file from knowledge base.

---

## Traces & Spans

### POST /v2/spans

Create a span.

```json
{
  "name": "string (required)",
  "id": "UUID (optional, auto-generated)",
  "trace_id": "UUID",
  "parent_id": "UUID",
  "type": "string",
  "start_time": "ISO datetime",
  "end_time": "ISO datetime",
  "input": "any",
  "output": "any",
  "error": "string",
  "meta": {"key": "value"}
}
```

### GET /v2/spans/{id}

Get span details.

### PATCH /v2/spans/{id}

Update span (add output, end_time, etc.).

### DELETE /v2/spans/{id}

Delete span.

### POST /v2/spans/{id}/save_examples

Save span data to function's dataset.

### POST /v2/spans/{id}/feedback

Submit feedback on a span.

```json
{
  "score": "number (0.0-1.0, required)",
  "comment": "string",
  "save_to_dataset": "boolean"
}
```

### GET /v2/traces

List traces. Query: `name`, `offset`, `limit`.

Response: `{data: [{id, name, start_time, end_time, duration_ms, status, total_tokens}], meta: {total_count}}`

### GET /v2/traces/{id}

Get trace details (includes all child spans).

---

## Span Metrics

### POST /v2/spans/{span_id}/metrics

Create metric on span.

```json
{"dimension": "string", "value": "number", "comment": "string (optional)"}
```

### GET /v2/spans/{span_id}/metrics

List metrics for span.

### PATCH /v2/spans/{span_id}/metrics/{metric_id}

Update metric.

### DELETE /v2/spans/{span_id}/metrics/{metric_id}

Delete metric.

---

## Datasets

### POST /v2/datasets/{id}/entries

Add dataset entry.

```json
{
  "input": "string",
  "output": "string",
  "expected": "string",
  "comment": "string"
}
```

### GET /v2/datasets/{id}/entries

List entries. Query: `offset`, `limit`.

### GET /v2/datasets/{id}/entries/{entry_id}

Get entry.

### PATCH /v2/datasets/{id}/entries/{entry_id}

Update entry.

### DELETE /v2/datasets/{id}/entries/{entry_id}

Delete entry.

### POST /v2/datasets/{id}/query

Semantic search on dataset entries.

---

## Embeddings

### POST /v2/embeddings

Generate vector embeddings.

```json
{
  "input": "string or string[]",
  "model": "string (optional)"
}
```

---

## Models

### GET /v2/models

List all available models.

### POST /v2/models/custom

Register custom model.

### GET /v2/models/custom

List custom models.

### GET /v2/models/custom/{id}

Get custom model.

### GET /v2/models/custom/by-name/{name}

Get custom model by name.

### PATCH /v2/models/custom/{id}

Update custom model.

### DELETE /v2/models/custom/{id}

Delete custom model.

---

## Other Endpoints

### POST /v2/ocr

Process images with OCR.

### POST /v2/rerank

Rerank documents by relevance.

### POST /v2/openai/chat/completions

OpenAI-compatible chat completions endpoint.

### GET /v2/analytics/usage

Get usage analytics.

---

## Common Response Patterns

**Success**: HTTP 200/201 with JSON body.

**Pagination**: `{data: [...], meta: {total_count}}` with `offset`/`limit` query params.

**Errors**: `{"detail": "error message"}` with appropriate HTTP status (400, 401, 404, 422, 502).

**Soft deletes**: DELETE returns 204. Resources are marked deleted, not removed.
