# Tracing Reference (Node SDK)

Tracing provides full observability into your AI operations with hierarchical spans, metrics, and dashboard visibility.

## Contents
- [Spans and Parent-Child Relationships](#spans-and-parent-child-relationships)
- [Creating Spans](#creating-spans)
- [Saving Metrics](#saving-metrics)
- [Listing and Getting Metrics](#listing-and-getting-metrics)
- [Listing Traces](#listing-traces)
- [Getting a Trace](#getting-a-trace)
- [Getting Span Details](#getting-span-details)
- [Saving Spans to Datasets](#saving-spans-to-datasets)
- [Tags for Filtering](#tags-for-filtering)
- [Deleting Spans and Metrics](#deleting-spans-and-metrics)
- [Submitting Feedback](#submitting-feedback)
- [Trace Hierarchy](#trace-hierarchy)
- [Best Practices](#best-practices)

## Spans and Parent-Child Relationships

Group related operations using `parentSpanId`:

```typescript
import { Opper } from "opperai";

const opper = new Opper({
  httpBearer: process.env["OPPER_HTTP_BEARER"] ?? "",
});

// Create a parent span
const parentSpan = await opper.spans.create({
  name: "qa_pipeline",
});

// Child operations reference the parent
const result1 = await opper.call({
  name: "retrieve_context",
  instructions: "Find relevant context",
  input: "What is Opper?",
  parentSpanId: parentSpan.id,
});

const result2 = await opper.call({
  name: "generate_answer",
  instructions: "Answer based on context",
  input: result1.message,
  parentSpanId: parentSpan.id,
});
```

## Creating Spans

```typescript
const span = await opper.spans.create({
  name: "my_operation",
  input: { query: "test" },
  metadata: { step: "preprocessing" },
});

// Update span with output when done
await opper.spans.update(span.id, {
  output: { result: "processed" },
});
```

## Saving Metrics

```typescript
await opper.spanMetrics.createMetric(span.id, {
  dimension: "quality_score",
  value: 4.5,
});

await opper.spanMetrics.createMetric(span.id, {
  dimension: "relevance",
  value: 0.92,
  comment: "Optional comment for this metric",
});
```

## Listing and Getting Metrics

```typescript
// List metrics for a span
const metrics = await opper.spanMetrics.list(span.id);
for (const m of metrics) {
  console.log(`${m.dimension}: ${m.value}`);
}

// Get a specific metric (requires both spanId and metricId)
const metric = await opper.spanMetrics.get(span.id, "metric_123");
```

## Listing Traces

```typescript
const traces = await opper.traces.list();
for (const trace of traces) {
  console.log(`${trace.id}: ${trace.name}`);
}
```

## Getting a Trace

```typescript
const trace = await opper.traces.get("trace_123");
console.log(trace.name);
console.log(trace.spans); // Child spans
```

## Getting Span Details

```typescript
const span = await opper.spans.get("span_456");
console.log(span.input);
console.log(span.output);
console.log(span.metadata);
```

## Saving Spans to Datasets

Export span data as training examples:

```typescript
await opper.spans.saveExamples("span_456");
```

## Tags for Filtering

Tags on calls appear on their spans in the dashboard:

```typescript
const result = await opper.call({
  name: "classify",
  instructions: "Classify the text",
  input: "some text",
  tags: {
    environment: "production",
    user_id: "usr_123",
    experiment: "v2",
  },
});
```

## Deleting Spans and Metrics

```typescript
// Delete a metric (requires both spanId and metricId)
await opper.spanMetrics.delete(span.id, "metric_123");

// Delete a span
await opper.spans.delete("span_456");
```

## Submitting Feedback

Submit human feedback (thumbs up/down) on a span's output:

```typescript
await opper.spans.submitFeedback(span.id, {
  score: 1.0, // 1.0 = thumbs up, 0.0 = thumbs down
  comment: "Great response!", // optional
});
```

## Trace Hierarchy

Traces form a tree structure visible in the dashboard:

```
Trace: "qa_pipeline"
├── Span: "retrieve_context" (knowledge query)
├── Span: "generate_answer" (LLM call)
│   ├── Metric: quality_score = 4.5
│   └── Metric: latency_ms = 320
└── Span: "validate" (LLM call)
```

## Best Practices

- Use descriptive span names: `"retrieve_context"` not `"step1"`
- Always pass `parentSpanId` to group related operations
- Save metrics that matter for quality evaluation
- Use `tags` consistently for effective dashboard filtering
- Export good examples to datasets for fine-tuning
- Clean up test spans/traces to keep the dashboard useful
