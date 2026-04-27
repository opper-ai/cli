# CLI Usage Analytics

Track token usage, costs, and analytics from the command line.

## Contents
- [Basic Usage](#basic-usage)
- [All Flags](#all-flags)
- [Fields (--fields)](#fields---fields)
- [Grouping (--group-by)](#grouping---group-by)
- [Output Formats](#output-formats)
- [Examples](#examples)
- [Response Format](#response-format)
- [Tips](#tips)

## Basic Usage

```bash
# List usage with current defaults
opper usage list

# Specify date range (YYYY-MM-DD)
opper usage list --from-date=2026-04-01 --to-date=2026-04-30

# Specify exact time range (RFC3339)
opper usage list --from-date=2026-04-27T14:00:00Z --to-date=2026-04-27T16:00:00Z

# Last 2 hours, minute granularity
opper usage list --from-date=2026-04-27T09:30:00Z --to-date=2026-04-27T11:30:00Z --granularity=minute
```

## All Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--from-date <d>` | Start date/time (ISO date or RFC3339) | |
| `--to-date <d>` | End date/time (ISO date or RFC3339) | |
| `--granularity <g>` | Time bucket size: `minute`, `hour`, `day`, `month`, `year` | server default |
| `--fields <csv>` | Comma-separated extra fields from event metadata to sum | |
| `--group-by <csv>` | Comma-separated group-by keys (tag names) | |
| `--out <format>` | Output format: `text` or `csv` | `text` |

## Fields (--fields)

The `--fields` flag selects numeric fields from event metadata to sum. Valid values for generation events:

| Field | Description |
|-------|-------------|
| `prompt_tokens` | Input/prompt tokens |
| `completion_tokens` | Output/completion tokens |
| `total_tokens` | Total tokens (prompt + completion) |

**Important:** `cost` and `count` are always included automatically. Do NOT pass `count` as a field — it will cause an error.

```bash
# Correct: request token fields
opper usage list --fields=total_tokens,prompt_tokens,completion_tokens

# Also fine: cost in --fields is silently ignored (already included)
opper usage list --fields=total_tokens,cost

# WRONG: count is not a valid --fields value
# opper usage list --fields=total_tokens,count  # ERROR
```

## Grouping (--group-by)

Group results by tag keys. Tags are set during function calls via the SDK `tags` parameter.

Built-in tags available for all generation events:

| Tag | Description |
|-----|-------------|
| `model` | LLM model used |
| `function.name` | Function path/name |
| `function.uuid` | Function UUID |
| `project.name` | Project name |
| `project.uuid` | Project UUID |
| `span_uuid` | Span UUID |
| `trace_uuid` | Trace UUID |

Custom tags emitted from your application are also available:

```bash
# Group by model
opper usage list --group-by=model

# Group by custom tag
opper usage list --group-by=customer_id

# Multiple group-by keys
opper usage list --group-by=model,project.name
```

## Output Formats

```bash
# Default: text table
opper usage list

# CSV
opper usage list --out=csv

# Redirect to file
opper usage list --out=csv > usage_report.csv
```

## Examples

```bash
# Token usage for a date range grouped by model
opper usage list --from-date=2026-04-01 --to-date=2026-04-30 --fields=total_tokens --group-by=model

# Hourly cost breakdown for today
opper usage list --granularity=hour

# Last 2 hours by minute
opper usage list --from-date=2026-04-27T09:00:00Z --to-date=2026-04-27T11:00:00Z --granularity=minute

# Usage per model
opper usage list --fields=total_tokens,prompt_tokens,completion_tokens --group-by=model

# Export monthly report
opper usage list --from-date=2026-04-01 --to-date=2026-04-30 --fields=total_tokens --group-by=model --out=csv > april_usage.csv
```

## Response Format

Every response includes these auto-computed fields:
- **Time bucket** — the time period (based on `--granularity`)
- **Cost** — total cost in USD for the period
- **Count** — number of events in the period

Plus any fields requested via `--fields` and grouping keys from `--group-by`.

## Tips

- Date format is RFC3339: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ` for time precision.
- Use `--granularity=minute` or `--granularity=hour` for short time ranges.
- Tag your application's calls (via the SDK `tags` parameter) for granular usage attribution.
- CSV export is useful for importing into spreadsheets or billing systems.
- Usage data is available shortly after calls complete.
