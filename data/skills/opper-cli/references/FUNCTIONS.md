# CLI Function Management

Manage Opper functions from the command line.

## Calling Functions

```bash
# Basic: opper call <name> <instructions> <input>
opper call extract_entities "Extract named entities" "Tim Cook announced Apple's new office in Austin."

# With model override
opper call --model openai/gpt-4o extract_entities "Extract named entities" "Some text..."

# Pipe input from stdin
cat document.txt | opper call summarize "Summarize this document"

# With debug output
opper call --debug myfunction "instructions" "input"
```

## Listing Functions

```bash
opper functions list
```

## Function Chat

Interactive multi-turn chat with a function:

```bash
# Direct message
opper functions chat myfunction "What can you help me with?"

# Pipe a message
echo "Explain quantum computing" | opper functions chat myfunction
```

The chat command maintains conversation context with the function, allowing follow-up questions.

## Tags

Add metadata tags for filtering and cost attribution:

```bash
opper call --tags customer_id=acme,env=prod myfunction "instructions" "input"
```

## Tips

- Function names should be descriptive and unique (e.g., `extract_entities`, `classify_ticket`)
- If a function doesn't exist, `call` auto-creates it on the Opper platform
- Use `--debug` to see the full request/response cycle
- Pipe long inputs from files rather than passing them as arguments
