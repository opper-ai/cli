# Tracing API Reference

Complete HTTP API for creating traces, spans, metrics, and feedback for observability.

## Contents
- [Create a Span](#create-a-span)
- [Child Spans](#child-spans)
- [Link Calls to Spans](#link-calls-to-spans)
- [Update a Span](#update-a-span)
- [Add Metrics to Spans](#add-metrics-to-spans)
- [List Metrics](#list-metrics)
- [Submit Feedback](#submit-feedback)
- [Save to Dataset](#save-to-dataset)
- [List Traces](#list-traces)
- [Get Trace with Spans](#get-trace-with-spans)
- [Tags for Filtering](#tags-for-filtering)
- [Delete Operations](#delete-operations)
- [Trace Hierarchy Example](#trace-hierarchy-example)
- [Best Practices](#best-practices)

## Create a Span

Spans are the building blocks of traces. Create a root span to start a trace:

```bash
curl -X POST https://api.opper.ai/v2/spans \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my_pipeline",
    "input": {"query": "user question"},
    "meta": {"environment": "production"}
  }'
```

Response:

```json
{
  "id": "span-uuid-here",
  "name": "my_pipeline",
  "trace_id": "trace-uuid",
  "start_time": "2025-01-15T10:30:00Z"
}
```

## Child Spans

Link operations together with `parent_id`:

```bash
# Create child span
curl -X POST https://api.opper.ai/v2/spans \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "retrieve_context",
    "parent_id": "parent-span-uuid",
    "input": {"query": "search term"}
  }'
```

## Link Calls to Spans

Use `parent_span_id` in `/v2/call` to attach task completions to a trace:

```bash
# Create root span
ROOT=$(curl -s -X POST https://api.opper.ai/v2/spans \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "qa_pipeline"}' | jq -r '.id')

# Call with parent span
curl -X POST https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"answer_question\",
    \"instructions\": \"Answer the question\",
    \"input\": \"What is Opper?\",
    \"parent_span_id\": \"$ROOT\"
  }"
```

## Update a Span

Add output, end time, or metadata after processing:

```bash
curl -X PATCH https://api.opper.ai/v2/spans/{span_id} \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "output": {"result": "processed successfully"},
    "end_time": "2025-01-15T10:30:05Z",
    "meta": {"tokens_used": 150}
  }'
```

## Add Metrics to Spans

Attach evaluation metrics:

```bash
curl -X POST https://api.opper.ai/v2/spans/{span_id}/metrics \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dimension": "quality_score", "value": 4.5}'

curl -X POST https://api.opper.ai/v2/spans/{span_id}/metrics \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"dimension": "relevance", "value": 0.92, "comment": "optional note"}'
```

## List Metrics

```bash
curl https://api.opper.ai/v2/spans/{span_id}/metrics \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Submit Feedback

Provide human feedback on span quality:

```bash
curl -X POST https://api.opper.ai/v2/spans/{span_id}/feedback \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "score": 1.0,
    "comment": "Great answer, very relevant",
    "save_to_dataset": true
  }'
```

Score: `1.0` = positive, `0.0` = negative. Setting `save_to_dataset: true` adds the span's input/output as a training example.

## Save to Dataset

Save span data as training examples for fine-tuning:

```bash
curl -X POST https://api.opper.ai/v2/spans/{span_id}/save_examples \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## List Traces

```bash
curl "https://api.opper.ai/v2/traces?limit=20&offset=0" \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

Response:

```json
{
  "data": [
    {
      "id": "trace-uuid",
      "name": "qa_pipeline",
      "start_time": "2025-01-15T10:30:00Z",
      "end_time": "2025-01-15T10:30:05Z",
      "duration_ms": 5000,
      "status": "completed",
      "total_tokens": 250
    }
  ],
  "meta": {"total_count": 42}
}
```

## Get Trace with Spans

```bash
curl https://api.opper.ai/v2/traces/{trace_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

Returns the trace details including all child spans.

## Tags for Filtering

Tags on calls appear in their spans:

```bash
curl -X POST https://api.opper.ai/v2/call \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "task",
    "instructions": "...",
    "input": "...",
    "tags": {"environment": "prod", "user_id": "usr_123"}
  }'
```

Tags are searchable and filterable in the dashboard.

## Delete Operations

```bash
# Delete a metric
curl -X DELETE https://api.opper.ai/v2/spans/{span_id}/metrics/{metric_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"

# Delete a span
curl -X DELETE https://api.opper.ai/v2/spans/{span_id} \
  -H "Authorization: Bearer $OPPER_API_KEY"
```

## Trace Hierarchy Example

A typical trace tree:

```
Trace: "qa_pipeline"
├── Span: "retrieve_context" (manual span)
│   └── input: {"query": "..."}
├── Span: "generate_answer" (from /v2/call via parent_span_id)
│   ├── Metric: quality_score = 4.5
│   ├── Metric: relevance = 0.92
│   └── Feedback: score = 1.0
└── Span: "validate_output" (from /v2/call)
```

## Best Practices

- Create a root span per user request or pipeline execution
- Use `parent_span_id` in all `/v2/call` requests to link them to traces
- Add metrics for quality dimensions you care about (accuracy, relevance, latency)
- Use `tags` consistently for filtering (environment, user, experiment)
- Save positive examples to datasets for few-shot improvement
- Use feedback to build evaluation datasets over time
