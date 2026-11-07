# seek-search (`seek`)

Bun CLI for agents: web search and page fetch through Vercel AI Gateway's **DeepSeek Search** and
**DeepSeek Fetch** tools. Markdown output by default, `--json` for raw data.

The gateway only runs these tools when a model calls them. `seek` lets a fixed host model
(`zai/glm-5.3-flash`, reasoning `none`) make exactly one tool call and prints the tool's own raw
result. With `--question`, one more call to the same model (reasoning `low`) writes a short
answer from that result.

## Install

```
bun install -g github:<user>/seek-search                       # puts `seek` on your PATH
echo 'export SEEK_SEARCH_GATEWAY_KEY=...' >> ~/.zshrc          # gateway key; never commit it
seek install                                             # symlinks skill/ to ~/.claude/skills/seek-search
```

- Update: run the same `bun install -g github:<user>/seek-search` again. The skill symlink points
  into the global install, so it updates too.
- Uninstall: `bun remove -g seek-search && rm ~/.claude/skills/seek-search`.
- From a local checkout instead: `bun install && bun link`, then `seek install`.

No build step: Bun runs `cli.ts` directly (shebang `#!/usr/bin/env bun`, `bin` in package.json).

## Commands

```
seek search <query...> [filters] [--question "Q" [--answer-only]] [--count N] [--content] [--json] [--no-cache]
seek fetch <url> [--question "Q" [--answer-only]] [--max-chars N] [--json] [--no-cache]
seek install
seek --help
```

Search filters, each turned into a search operator (`*` = repeatable):

| Flag | Operator |
|---|---|
| `--site D`* | `site:D` (several = OR) |
| `--exclude-site D`* | `-site:D` |
| `--phrase "P"`* | `"P"` |
| `--exclude W`* | `-W` / `-"W W"` |
| `--lang L`* | `lang:en,de` |
| `--after` / `--before DATE` | `after:` / `before:` (`YYYY` or `YYYY-MM-DD`) |

Operators can also go straight into the query. Full query max 128 chars.

Other flags: `--count 1-50` (default 10), `--content` (full page text per result),
`--max-chars N` (fetch: trims printed page only), `--json`, `--no-cache`.

## Two modes

- **Raw** (default): the tool's results or page only. The caller decides what to use.
- **`--question "Q"`**: a short answer (max 5 sentences, from the material only; search cites `[n]`,
  fetch names the section; says plainly when not answered), then `---`, then the raw output.
  Fetch gives the model the first 100k chars. `--answer-only` prints just the answer.
  `--json` adds `question` and `answer`.

## Cache

Raw tool results and answers are cached in `~/.cache/seek` (or `$XDG_CACHE_HOME/seek`), keyed by
the exact inputs: search 1 hour, fetch 1 day (`SEARCH_TTL_MS` / `FETCH_TTL_MS` in `cli.ts`).
An identical repeat makes no gateway call. `--no-cache` skips it.

## Debug

`SEEK_DEBUG=1` prints the answer calls' token usage to stderr.

## Implementation note

`@ai-sdk/gateway` has no DeepSeek tool helpers, so `cli.ts` declares the provider-executed ids
`gateway.deepseek_search` and `gateway.deepseek_fetch` with `@ai-sdk/provider-utils`. Keep that
package on the version `@ai-sdk/gateway` depends on.

## Cost

$0.75 per 1,000 successful searches or fetches, plus a few host-model tokens. `--question` adds
one model call (~8k input tokens for a docs page). Failed or cached calls are free.
