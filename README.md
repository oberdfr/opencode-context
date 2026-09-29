# opencode-context

`/context` for OpenCode: a brief on how the context window is being spent.

```
  Context Usage                                              esc

  anthropic/claude-sonnet-5
  ████░░░░░░░░░░░░░░░░░░  21.1k/190k tokens  (11%)
  Free space: 168.9k (89%)
  Compaction threshold: 105k (10%)
  ██░░░░░░░░░░░░░░░░░░░  105k
  Counted from the request body with the anthropic tokenizer.

  Usage by category
    Tools            ██████████   13.8k tokens  (66%)
    Messages         ██░░░░░░░░    3.9k tokens  (19%)
    Skills           ░░░░░░░░░░    1.8k tokens  (9%)
    System prompt    ░░░░░░░░░░    1.3k tokens  (6%)
    MCP tools        ░░░░░░░░░░    0.8k tokens  (4%)
  + 631 request framing (JSON envelope, model, generation settings)

  Memory files
    .opencode/AGENTS.md          241 tokens

  Skills
    design-md                    317 tokens
    design-create                156 tokens

  MCP connectors
    chrome-devtools         1.2k tokens  30 tools
    open-design               840 tokens  22 tools

  Tools
    subagent                     523 tokens
    shell                        275 tokens

  r to refresh
```

Also available as `/context-usage` or `/ctx`, and in the command palette.

The dialog is centred and grows to fill the frame the host gives it, so the
scrollable area takes the leftover height rather than leaving it empty. It
scrolls when the content is taller than the window. The gauge and the title stay pinned, so the state of the
window is visible however far down the lists you have scrolled. The dialog is
never given a fixed height: it sizes itself to its content, and only a cap
keeps a long report inside a short terminal. Forcing a height on the root would
stretch the frame instead of the scroll area inside it.

## What it reports

| Section | Meaning |
| --- | --- |
| Window gauge | Tokens the model occupies the window with, over `limit.context`. |
| Compaction threshold | Where compaction fires, with the share of the window it reserves. `┃` on the bar marks the same point and the `=` run beneath spans the same distance to the end, so the reserve reads as width too. |
| Free space | What is left of the window. |
| Usage by category | How the tokens split across system prompt, tools, MCP tools, memory files, skills, environment and messages. |
| Request framing | Tokens the provider counted that are prompt *envelope* rather than content. |
| Memory files | Each instruction file in the prompt, with its own cost. |
| Skills | Each skill in the prompt's catalogue, with the cost of advertising it. |
| MCP connectors | One row per connected MCP server: what it costs in total, and how many tools it contributes. A server can add thirty tools, and listing them all would bury the rest of the report. |
| Tools | Each builtin tool, with the cost of its name, description and JSON schema. |

## Accuracy

The dialog states its own provenance, because a context report is only worth
reading if the numbers can be trusted.

**The total is the provider's own count.** It is `input + cache.read +
cache.write` from the most recent assistant turn — what the provider itself
charged for occupying the window. Output tokens are excluded: they are what the
model produced, not what it will read next.

**The split is counted, not guessed.** The measurement is taken from the exact
serialized request body the provider was handed, which the
`session.http.request` hook exposes, and each part is counted with a real
tokenizer (`js-tiktoken`, `cl100k_base`/`o200k_base`, selected by model family).
There is no character heuristic in the reported path.

Two things are reported separately because they are genuinely different:

- **Request framing.** The categories measure prompt *content*; the provider
  also counts the JSON around it — keys, brackets, the model name, generation
  settings. That remainder is measured too, so `categories + framing` equals the
  request exactly rather than falling short by an unexplained amount.
- **Tokenizer identity.** The dialog names the tokenizer it used, and says so
  plainly when it is standing in. Two cases are disclosed rather than blended:
  a recognised family is counted with its own table (or, for Anthropic, the
  closest well-known one, since Anthropic publishes no BPE), and a model whose
  family is not recognised is counted with a general BPE and labelled
  *approximate*. That is a far better position than dropping to a character
  heuristic for every model released behind a provider-specific name.

When a model family has no tokenizer, the report degrades to the provider's
total plus a proportionally-apportioned split and says so in the dialog. It
never presents a guess as a measurement, and it never silently rescales
tokenizer-exact parts to make them fit.

## How it works

Two hooks feed the report:

- `session.http.request` carries the exact serialized JSON body. This is the
  primary source and the reason the numbers can be exact. Three body shapes are
  handled — Anthropic Messages, OpenAI Chat Completions, OpenAI Responses — each
  verified against live traffic. A body that matches none is reported as
  unrecognised rather than read as empty.
- `session.context` carries the prompt before serialization. It is a fallback
  for non-JSON bodies and never overwrites a body capture, which is strictly
  more faithful.

OpenCode emits the prompt as text parts that may mix several sources, without
tagging which source a line came from. The split is therefore made by matching
the markers the prompt builder emits:

| Marker | Bucket |
| --- | --- |
| `# Code Mode` | Tools (the embedded tool catalogue) |
| `<mcp_instructions>` | MCP tools |
| `Instructions from: <path>` | Memory files, one entry per file |
| `Skills provide specialized instructions…` / `<available_skills>` | Skills |
| `Today's date:` / `Here is some useful information about the environment…` | Environment |
| anything else | System prompt |

Each marker was verified against a live session. Lines matching none fall into
"System prompt", so a future change to the format degrades to a coarser
breakdown rather than a wrong one.

### Where MCP tool cost actually lives

With Code Mode on, most tools are not sent as provider tool definitions at all.
They are described once, in the system prompt, as a catalogue of call
signatures that `execute` dispatches — and that catalogue is where **every tool
an MCP server contributes** appears. Looking only at the request's `tools` array
finds none of them, which is why an earlier version reported no MCP cost at all.

The catalogue is parsed into namespaces and per-tool entries. A namespace whose
name matches a connected MCP server is charged to the MCP bucket; everything
else stays in the builtin tool bucket. Per-tool costs are kept in the report but
the dialog sums them per connector, so a server with thirty tools is one line
rather than thirty.

Two bounds matter, and both are load-bearing:

- The catalogue is parsed from the tool section alone, never from the whole
  part. The `# Code Mode` heading is only the head of a much larger tool
  section that also holds the skills catalogue, memory files and the
  environment block; a catalogue allowed to run to the end of the part claims
  those, charges them to the tool bucket, and counts them a second time in
  their own categories.
- Its line indices are relative to the text it was parsed from. Parsing the
  joined system parts and applying the result to one part's lines removes the
  wrong rows.

Both are covered by tests that fail if either bound is removed.

Servers are matched by name, refreshed per report because MCP servers connect
after plugin startup. A server that is not connected sends no tools and costs
nothing.

### Remembering a session you switch back to

A capture exists only once a session has actually made a request, and holding
one for every session ever seen would be unbounded. Both limits are handled
without making `/context` come up empty:

- The last 8 captures are kept in memory, least-recently-used evicted.
- Captures are also written through to durable storage, and the 8 most recent
  are kept there, so they survive a server restart. The raw request body is
  dropped before writing: it is the largest field and only feeds the framing
  figure, which the report simply omits when it is unavailable. A capture whose
  transcript is over 1 MB is not written at all.

The model never depends on a capture. A session records the model it is on
whether or not this process ever saw a request for it, so switching to a chat
that last ran before a restart still names the model, knows the window, and
shows the provider's own total. Only the breakdown needs a capture, and its
absence is stated in the dialog rather than shown as zero.

### The compaction marker

The bar marks where OpenCode compacts, and the arithmetic mirrors its own,
read out of the shipped build rather than assumed: an explicit
`compaction.buffer` wins, and otherwise the reserve is the larger of 10% of the
window and 16k tokens, with the 16k floor applying only from a 32k window
upwards. The bar's colour bands are relative to that trigger, so a session close
to compaction does not look calm just because its window is large.

## Requirements

OpenCode 2.0.18 or newer — the plugin uses the `session.http.request` hook and
the RPC bus introduced alongside it.

`js-tiktoken` is an optional dependency. It is listed under
`optionalDependencies` and is installed by default; without it the plugin still
works, with the split labelled as an estimate.

## Configuration

Optional, in `opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "file:///path/to/opencode-context",
      "options": {
        // Token headroom reserved for compaction.
        "compactionBuffer": 20000
      }
    }
  ]
}
```

Only needed to override `compaction.buffer`; leave it unset to use OpenCode's
own value and default formula.

## Development

```sh
npm run typecheck
npm test
```

The test fixtures reproduce prompt structure, request bodies and the Code Mode
catalogue captured from live sessions rather than being written to match the
code, since the segmentation and parsing rules are written against those shapes
and would otherwise pass vacuously. `src/catalog.real.txt` is a catalogue captured from a
live session, kept so the parser is checked against the real grammar rather than
only against the fixture.

## Layout

| File | Role |
| --- | --- |
| `src/body.ts` | Reads a provider's serialized request body. The only place that knows about provider-specific shapes. |
| `src/catalog.ts` | Parses the Code Mode tool catalogue, which is where MCP tool cost lives. |
| `src/measure.ts` | Tokenizer resolution, prompt segmentation, counting, reconciliation. No OpenCode types. |
| `src/format.ts` | Rendering helpers: bars, the compaction marker, counts, path elision. |
| `src/rpc.ts` | The report contract, shared by both halves. |
| `src/index.ts` | Server half: captures requests, answers the report. |
| `src/tui.tsx` | Terminal half: registers `/context`, renders the dialog. |
