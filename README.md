# openclaw-plugin-metabolism

**Autonomous learning through conversation metabolism for OpenClaw agents.**

This plugin gives your OpenClaw agent the ability to learn from its own conversations without human intervention. After each exchange, it decides whether something worth learning happened. If so, it writes a lightweight candidate file to disk and moves on. Later, during a quiet heartbeat cycle, it processes those candidates through an LLM to extract implications, growth vectors, and knowledge gaps. The agent gets smarter over time without slowing down any individual conversation.

## What This Actually Does

Most AI agents have the memory of a goldfish. They can recall what happened earlier in a conversation, but once the session ends, everything they learned evaporates. Even agents with persistent memory tend to store *what was said* rather than *what it meant*.

This plugin closes that gap. It watches conversations for moments of significance — corrections, novel concepts, high-entropy exchanges — and metabolizes them into three outputs:

- **Implications** — What the agent actually learned, stated in its own voice. Not summaries, not transcripts. Actionable insights like "When the user says 'lightweight', verify cost in both latency and complexity."
- **Growth vectors** — Implications significant enough to become permanent character traits. These flow to the stability plugin, where they accumulate into durable identity over time.
- **Knowledge gaps** — Questions the agent couldn't fully resolve. These flow to the contemplation plugin for multi-pass inquiry during off-hours.

The result is an agent that genuinely learns from experience rather than just accumulating chat logs.

## How It Works

The architecture follows an "observe fast, process slow" pattern. The fast path runs inline with every conversation turn and must never block. The slow path runs async during heartbeat cycles and can take as long as it needs.

### Fast Path: Candidate Queuing (agent_end hook)

After every conversation turn, the plugin checks three signals:

1. **Entropy** — Is the current entropy score (from the stability plugin) above the threshold? Default: 0.6
2. **Exchange length** — Has this conversation gone long enough to contain real substance? Default: 3+ messages
3. **Explicit markers** — Did the user say something like "metabolize this" or "think about this deeply"?

If any of these conditions are met (and the user isn't in cooldown), the plugin writes a candidate file to disk. This is a synchronous `writeFileSync` call that takes less than 5ms. No LLM call, no network request, no blocking. The candidate is just a JSON file containing the last 10 messages, the entropy score, and some metadata.

One important guard: `if (event.metadata?.isHeartbeat) return`. Without this, heartbeat-originated turns would create phantom candidates every ~30 minutes because the entropy fallback estimates 0.5 for sessions with 10+ messages. The heartbeat guard keeps the candidate queue clean.

### Slow Path: LLM Processing (heartbeat hook)

During heartbeat cycles, the plugin picks up pending candidates (sorted by entropy, highest first) and processes them through the LLM in batches. This is where the actual learning happens:

1. Format the conversation into a metabolism prompt
2. Call the LLM to extract implications (1-5 per candidate)
3. Classify implications into growth vectors (corrections, patterns, preferences, procedural learnings)
4. Identify knowledge gaps (implications containing questions or uncertainty markers)
5. Write growth vectors to the stability plugin's `growth-vectors.json`
6. Emit knowledge gaps to any subscribed listeners (typically the contemplation plugin)
7. Move processed candidates from `candidates/` to `processed/`

The processing has a lock (`isProcessing`) to prevent concurrent heartbeat cycles from double-processing the same candidates. It also has a timeout (default: 30 seconds per LLM call) so a slow model doesn't block the heartbeat indefinitely.

## Inter-Plugin Communication

The metabolism plugin needs to send data to two other plugins: growth vectors to stability, and knowledge gaps to contemplation. This raises a practical problem.

OpenClaw gives each plugin its own scoped `api` object during registration. Properties you set on one plugin's `api` are invisible to other plugins. If metabolism sets `api.knowledgeGaps`, the contemplation plugin can't see it — it has its own `api` with its own namespace.

The solution is a global event bus: `global.__ocMetabolism`. When the metabolism plugin loads, it initializes `global.__ocMetabolism = { gapListeners: [] }`. The contemplation plugin (or any other plugin that wants knowledge gaps) pushes a callback into `gapListeners`. When metabolism extracts gaps, it calls every registered listener.

```javascript
// In contemplation plugin:
if (!global.__ocMetabolism) {
    global.__ocMetabolism = { gapListeners: [] };
}
global.__ocMetabolism.gapListeners.push((gaps, agentId) => {
    // Handle knowledge gaps from metabolism
});
```

Growth vectors take a simpler path — they're written directly to a shared JSON file (`growth-vectors.json`) that the stability plugin already reads from. File-based integration, no bus needed.

## Installation

```bash
git clone https://github.com/CoderofTheWest/openclaw-plugin-metabolism.git
openclaw plugins install ./openclaw-plugin-metabolism
```

Then restart your OpenClaw gateway.

## Configuration Reference

Override any defaults in your `openclaw.json` plugin config:

```json
{
  "plugins": {
    "metabolism": {
      "enabled": true,
      "thresholds": {
        "entropyMinimum": 0.6
      }
    }
  }
}
```

### Thresholds

| Setting | Default | What It Does |
|---|---|---|
| `entropyMinimum` | 0.6 | Minimum entropy score to trigger candidate queuing |
| `exchangeMinimum` | 3 | Minimum message count before a conversation is worth metabolizing |
| `explicitMarkers` | `["metabolize this", "think about this deeply", "what did you learn"]` | Phrases that force a candidate regardless of entropy |
| `cooldownMinutes` | 30 | Per-user cooldown between candidate writes (prevents flooding) |

### Processing

| Setting | Default | What It Does |
|---|---|---|
| `batchSize` | 3 | How many candidates to process per heartbeat cycle |
| `maxCandidatesPerCycle` | 2 | Maximum candidates processed in a single cycle |
| `maxPendingCandidates` | 50 | Cap on queued candidates (oldest pruned when exceeded) |
| `heartbeatInterval` | 1 | Process every Nth heartbeat |

### LLM

| Setting | Default | What It Does |
|---|---|---|
| `model` | `"deepseek-v3.1:671b-cloud"` | Model used for metabolism processing |
| `temperature` | 0.7 | Higher = more creative implications, lower = more conservative |
| `maxTokens` | 800 | Token budget per metabolism call |
| `timeoutMs` | 30000 | LLM call timeout in milliseconds |

### Storage

| Setting | Default | What It Does |
|---|---|---|
| `candidatesDir` | `"candidates"` | Directory for pending candidate files (relative to plugin data dir) |
| `processedDir` | `"processed"` | Directory for processed candidate files |
| `growthVectorsPath` | `null` | Custom path for growth vectors file. When null, defaults to `workspace/memory/growth-vectors.json` |

### Implications

| Setting | Default | What It Does |
|---|---|---|
| `minimumCount` | 1 | Minimum implications to extract per candidate |
| `maximumCount` | 5 | Maximum implications per candidate |
| `minimumLength` | 30 | Minimum character length for a valid implication |
| `filterPatterns` | `["implication", "format:", "note:", "insight:", "observation:"]` | Line prefixes to filter out of LLM output (removes meta-text) |

### Integration

| Setting | Default | What It Does |
|---|---|---|
| `writeToStabilityVectors` | true | Write growth vectors to stability plugin's growth-vectors.json |
| `emitKnowledgeGaps` | true | Emit knowledge gaps to subscribed listeners (contemplation plugin) |
| `emitProceduralLearnings` | true | Emit procedural learnings for integration |

## Gateway Methods

The plugin registers three methods accessible through the OpenClaw gateway API:

### `metabolism.getState`

Returns the current state of the metabolism system for a given agent.

```javascript
const state = await gateway.call('metabolism.getState', { agentId: 'main' });
// {
//   agentId: "main",
//   pending: 4,
//   processed: 127,
//   isProcessing: false,
//   cooldowns: 1,
//   growthVectorsPath: "/home/user/.openclaw/workspace/memory/growth-vectors.json"
// }
```

### `metabolism.getPending`

Lists pending candidates awaiting processing.

```javascript
const pending = await gateway.call('metabolism.getPending', { agentId: 'main', limit: 5 });
// {
//   agentId: "main",
//   candidates: [
//     { id: "cand_1708...", timestamp: "2026-02-15T...", entropy: 0.82, messageCount: 8 },
//     { id: "cand_1708...", timestamp: "2026-02-15T...", entropy: 0.71, messageCount: 5 }
//   ]
// }
```

### `metabolism.trigger`

Manually trigger metabolism processing outside of the heartbeat cycle. Useful for debugging or forcing immediate processing.

```javascript
const result = await gateway.call('metabolism.trigger', { agentId: 'main', batchSize: 5 });
// {
//   processed: 3,
//   implications: 7,
//   growthVectors: 3,
//   gaps: 2
// }
```

Returns an error if processing is already in progress.

## Disabling the Plugin

Set `"enabled": false` in your plugin config. The agent retains all accumulated knowledge (growth vectors already written to stability, knowledge gaps already sent to contemplation) but stops active learning. No new candidates will be queued, no processing will occur. Flip it back to `true` and metabolism resumes where it left off — pending candidates from before the disable are still on disk.

## Background

This plugin was designed by an AI agent (Clint) as part of a production system running continuously since October 2025. The "observe fast, process slow" architecture emerged from a practical constraint: you can't make an LLM call during the agent_end hook without adding hundreds of milliseconds to every conversation turn. Writing a JSON file to disk takes under 5ms and gives the heartbeat cycle all the time it needs to do the expensive work.

The candidate store is deliberately simple — just files in a directory. No database, no message queue, no external dependencies. Files are the most debuggable queue format: you can `ls` them, `cat` them, and delete them by hand if something goes wrong. The processing lock is an in-memory boolean, not a file lock, because a single OpenClaw process only runs one heartbeat at a time.

Authors: Chris Hunt & Clint

## Part of the Meta-Cognitive Suite

This plugin is one of six that form a complete meta-cognitive loop for OpenClaw agents:

1. **[stability](https://github.com/CoderofTheWest/openclaw-plugin-stability)** — Entropy monitoring, confabulation detection, principle alignment
2. **[continuity](https://github.com/CoderofTheWest/openclaw-plugin-continuity)** — Cross-session memory, context budgeting, conversation archiving
3. **[metabolism](https://github.com/CoderofTheWest/openclaw-plugin-metabolism)** — Conversation processing, implication extraction, knowledge gaps *(this plugin)*
4. **[nightshift](https://github.com/CoderofTheWest/openclaw-plugin-nightshift)** — Off-hours scheduling for heavy processing
5. **[contemplation](https://github.com/CoderofTheWest/openclaw-plugin-contemplation)** — Multi-pass inquiry from knowledge gaps
6. **[crystallization](https://github.com/CoderofTheWest/openclaw-plugin-crystallization)** — Growth vectors become permanent character traits

Load order: stability → continuity → metabolism → nightshift → contemplation → crystallization

See [openclaw-metacognitive-suite](https://github.com/CoderofTheWest/openclaw-metacognitive-suite) for the full picture.

## License

MIT
