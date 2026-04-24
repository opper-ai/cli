# Tracing Reference (Python SDK)

Tracing provides full observability into your AI operations with hierarchical spans, metrics, and dashboard visibility.

## Contents
- [Creating Spans](#creating-spans)
- [Span Hierarchy with parent_span_id](#span-hierarchy-with-parent_span_id)
- [Saving Metrics on Spans](#saving-metrics-on-spans)
- [Listing Traces](#listing-traces)
- [Getting a Trace](#getting-a-trace)
- [Span Operations](#span-operations)
- [Saving Spans to Datasets](#saving-spans-to-datasets)
- [Tags for Filtering](#tags-for-filtering)
- [Trace Hierarchy](#trace-hierarchy)
- [Dashboard Integration](#dashboard-integration)
- [Best Practices](#best-practices)

## Creating Spans

Create spans manually to group related operations:

```python
import os
from opperai import Opper
from datetime import datetime, timezone

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])

# Create a parent span for a pipeline
span = opper.spans.create(name="my_pipeline")

# All operations can reference this span as parent
response1 = opper.call(
    name="step1",
    instructions="First step",
    input="...",
    parent_span_id=span.id,
)

response2 = opper.call(
    name="step2",
    instructions="Second step",
    input=response1.message,
    parent_span_id=span.id,
)

# IMPORTANT: Close the parent span by setting end_time
# This is required for duration_ms to be calculated in the dashboard
opper.spans.update(
    span_id=span.id,
    end_time=datetime.now(timezone.utc),
)
```

## Span Hierarchy with parent_span_id

Create parent-child relationships between spans:

```python
import os
from opperai import Opper
from datetime import datetime, timezone

opper = Opper(http_bearer=os.environ["OPPER_HTTP_BEARER"])

# Create a top-level span for the pipeline
pipeline_span = opper.spans.create(name="document_pipeline")

# First operation under the pipeline
response1 = opper.call(
    name="summarize",
    instructions="Summarize the document",
    input="Long document text...",
    parent_span_id=pipeline_span.id,
)

# Second operation under the pipeline
response2 = opper.call(
    name="extract_topics",
    instructions="Extract key topics",
    input=response1.message,
    parent_span_id=pipeline_span.id,
)

# Close the parent span
opper.spans.update(
    span_id=pipeline_span.id,
    end_time=datetime.now(timezone.utc),
)
```

## Saving Metrics on Spans

Attach custom metrics to any span using `opper.span_metrics.create_metric()`:

```python
response = opper.call(
    name="generate_answer",
    instructions="Answer the question",
    input="What is Opper?",
)

# Save metrics on the span
opper.span_metrics.create_metric(
    span_id=response.span_id,
    dimension="quality_score",
    value=4.5,
)

opper.span_metrics.create_metric(
    span_id=response.span_id,
    dimension="relevance",
    value=0.92,
)

opper.span_metrics.create_metric(
    span_id=response.span_id,
    dimension="latency_ms",
    value=320,
)
```

## Listing Traces

```python
# List recent traces
traces = opper.traces.list()
for t in traces:
    print(f"{t.id}: {t.name} ({t.status})")
```

## Getting a Trace

```python
trace = opper.traces.get(trace_id="trace_123")
print(trace.name)
print(trace.spans)  # List of spans in this trace
```

## Span Operations

```python
# Get a specific span
span = opper.spans.get(span_id="span_456")

# Update span metadata
opper.spans.update(
    span_id="span_456",
    meta={"reviewed": True},
)
```

## Saving Spans to Datasets

Save span inputs/outputs as training examples:

```python
# Save a span's data to a dataset for fine-tuning or evaluation
opper.spans.save_examples(
    span_id="span_456",
    dataset_name="training_data",
)
```

## Tags for Filtering

Tags on calls automatically appear on their spans:

```python
response = opper.call(
    name="classify",
    instructions="Classify the text",
    input="some text",
    tags={
        "environment": "production",
        "user_id": "usr_123",
        "experiment": "v2",
    },
)
# These tags are visible in the dashboard for filtering
```

## Trace Hierarchy

Traces form a tree structure:

```
Trace: "qa_pipeline"
├── Span: "retrieve_context" (knowledge base query)
├── Span: "generate_answer" (LLM call)
│   └── Metric: quality_score = 4.5
└── Span: "validate_output" (LLM call)
```

## Dashboard Integration

All traces and spans appear in the Opper dashboard at [platform.opper.ai](https://platform.opper.ai) where you can:

- View trace timelines and span hierarchies
- Filter by tags, time range, or function name
- Inspect inputs, outputs, and metrics
- Export data for analysis
- Set up alerts on metrics

## Best Practices

- **Close parent spans**: Set `end_time` on manually created spans so duration is calculated
- **String outputs**: `spans.update()` requires `output` to be a string — use `json.dumps()` for dicts
- Use descriptive span names: `"user_query_pipeline"` not `"trace1"`
- Use `parent_span_id` to create hierarchical relationships
- Save metrics that matter for quality: accuracy, relevance, latency
- Use tags consistently across calls for effective filtering
- Keep span names stable — changing them breaks dashboard filters
