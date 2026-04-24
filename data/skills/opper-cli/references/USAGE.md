# CLI Usage Analytics

Track token usage, costs, and analytics from the command line.

## Contents
- [Basic Usage](#basic-usage)
- [All Flags](#all-flags)
- [Fields (--fields)](#fields---fields)
- [Grouping (--group-by)](#grouping---group-by)
- [Output Formats](#output-formats)
- [Graph Mode](#graph-mode)
- [Examples](#examples)
- [Response Format](#response-format)
- [Tips](#tips)

## Basic Usage

```bash
# List usage for today
opper usage list

# Specify date range (YYYY-MM-DD)
opper usage list --from-date=2025-05-15 --to-date=2025-05-16

# Specify exact time range (RFC3339)
opper usage list --from-date=2025-05-15T14:00:00Z --to-date=2025-05-15T16:00:00Z

# Last 2 hours (calculate from current UTC time)
opper usage list --from-date=2025-05-15T09:30:00Z --to-date=2025-05-15T11:30:00Z --granularity=minute
```

## All Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--from-date` | Start date/time (RFC3339 format) | |
| `--to-date` | End date/time (RFC3339 format) | |
| `--granularity` | Time bucket size: `minute`, `hour`, `day`, `month`, `year` | `day` |
| `--fields` | Fields from `event_metadata` to include and sum | |
| `--group-by` | Fields from `tags` to group by | |
| `--out` | Output format: `csv` | table |
| `--graph` | Show ASCII graph | false |
| `--graph-type` | Graph metric: `count` or `cost` | `count` |

## Fields (--fields)

The `--fields` flag selects numeric fields from event metadata to sum. Valid values for generation events:

| Field | Description |
|-------|-------------|
| `prompt_tokens` | Input/prompt tokens |
| `completion_tokens` | Output/completion tokens |
| `total_tokens` | Total tokens (prompt + completion) |

**Important:** `cost` and `count` are always included automatically in every response. Do NOT pass `count` as a field — it will cause an error.

```bash
# Correct: request token fields
opper usage list --fields=total_tokens,prompt_tokens,completion_tokens

# Also fine: cost in --fields is silently ignored (already included)
opper usage list --fields=total_tokens,cost

# WRONG: count is not a valid --fields value
# opper usage list --fields=total_tokens,count  # ERROR!
```

## Grouping (--group-by)

Group results by tag keys. Tags are set during function calls via `--tags` or SDK `tags` parameter.

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

Custom tags passed during calls are also available:

```bash
# Group by model
opper usage list --group-by=model

# Group by custom tag (set via --tags during calls)
opper usage list --group-by=customer_id

# Multiple group-by fields
opper usage list --group-by=model,project.name
```

## Output Formats

```bash
# Default: table format
opper usage list

# CSV export
opper usage list --out=csv

# Redirect to file
opper usage list --out=csv > usage_report.csv
```

## Graph Mode

```bash
# Show count over time as ASCII graph
opper usage list --graph

# Show cost over time
opper usage list --graph --graph-type=cost

# Graph with grouping
opper usage list --group-by=model --graph
```

## Examples

```bash
# Token usage for a date range grouped by model
opper usage list --from-date=2025-05-15 --to-date=2025-05-16 --fields=total_tokens --group-by=model

# Hourly cost breakdown for today
opper usage list --granularity=hour

# Last 2 hours by minute (use current UTC time)
opper usage list --from-date=2025-05-15T09:00:00Z --to-date=2025-05-15T11:00:00Z --granularity=minute

# Usage per model
opper usage list --fields=total_tokens,prompt_tokens,completion_tokens --group-by=model

# Export monthly report
opper usage list --from-date=2025-05-01 --to-date=2025-05-31 --fields=total_tokens --group-by=model --out=csv > may_usage.csv
```

## Response Format

Every response includes these auto-computed fields:
- **Time Bucket**: The time period (based on `--granularity`)
- **Cost**: Total cost in USD for the period
- **Count**: Number of events in the period

Plus any fields requested via `--fields` and grouping keys from `--group-by`.

## Tips

- Date format is RFC3339: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ` for time precision
- Use `--granularity=minute` or `--granularity=hour` for short time ranges
- Use `--tags` in `opper call` to enable granular usage tracking later
- CSV export is useful for importing into spreadsheets or billing systems
- Usage data is available shortly after calls complete
