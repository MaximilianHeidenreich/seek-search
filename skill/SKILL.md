---
name: seek-search
description: Web access via the `seek` CLI (DeepSeek Search/Fetch on Vercel AI Gateway). Use FIRST whenever you need anything from the web - search the web, read a page's content as Markdown, answer a question about a URL, find current docs, release notes, prices, dates or facts. Prefer it over built-in WebFetch/WebSearch when available.
---

# seek

Web search + page fetch. Markdown out. Raw tool results, no model retelling unless `--question`.

## When

- Need current info, docs, facts, release notes: `seek search`.
- Have URL, need content: `seek fetch`.
- Need one fact, not whole page/results: add `--question "Q" --answer-only`. Saves context.

## Decide

| Need | Command |
|---|---|
| Find pages, read them yourself | `seek search "q"` |
| Quick fact from web | `seek search "q" --question "Q" --answer-only` |
| Full page text | `seek fetch URL` |
| One fact from known page | `seek fetch URL --question "Q" --answer-only` |
| Answer + page to check it | `seek fetch URL --question "Q"` |

Read page itself (no `--question`) when: broad understanding, exact code, comparing details,
answer matters, or answer says page doesn't cover it.

## Flags

| Flag | Effect |
|---|---|
| `--site D`* | `site:D`, several = OR |
| `--exclude-site D`* | `-site:D` |
| `--phrase "P"`* | exact phrase |
| `--exclude W`* | drop word/phrase |
| `--lang L`* | `lang:en,de` |
| `--after` / `--before DATE` | `YYYY` or `YYYY-MM-DD` |
| `--count N` | search results 1-50, default 10 |
| `--content` | full page text per result (long; usually fetch instead) |
| `--question "Q"` | short answer first, then `---`, then raw output |
| `--answer-only` | with `--question`: answer only |
| `--max-chars N` | fetch: trim printed page (model still sees 100k) |
| `--json` | raw JSON; adds `answer` with `--question` |
| `--no-cache` | fresh results |

`*` = repeatable. Operators also work inside query.

## Examples

```
seek search "ScrollPosition" --site developer.apple.com --count 5
seek search bun release notes --site bun.sh --after 2026-09-01
seek search pencilkit lag --exclude-site reddit.com --lang en
seek search --phrase "database or disk is full" xcodebuild
seek search swift 6.3 release --site swift.org --question "When was Swift 6.3 released?" --answer-only
seek fetch https://bun.sh/docs/api/sqlite --question "How do I enable WAL mode?" --answer-only
seek fetch https://example.com/changelog --max-chars 4000
seek search "bun sqlite" --count 3 --json
```

## Output

- Search: `# Search: <query>`, count, then per result `## n. Title`, URL, `site · date`, snippet.
- Fetch: `# Title`, URL, page Markdown, `[truncated]` if cut.
- `--question`: `# Answer: Q`, answer, `---`, then above. Search cites `[n]`; fetch names section.
- Errors on stderr. Exit 2 = bad args (fix call). Exit 1 = missing key, blocked/empty page, gateway error.

## Cache

`~/.cache/seek` (or `$XDG_CACHE_HOME/seek`). Search 1h, fetch 1d, answers same as their command.
Identical repeat = instant, free. Many questions on one page = one fetch. `--no-cache` to refresh.

## Cost

~$0.00075 per uncached search/fetch. `--question` adds one small model call. Failed/cached = free.

## Gotchas

- Full query incl. operators max 128 chars. Exit 2 if longer.
- Some sites block fetch: exit 1, try other source.
- Answer only as good as material. Important answer: fetch cited `[n]` page, check.
- "Doesn't answer": fetch named results or search again.
- Key: `SEEK_SEARCH_GATEWAY_KEY` in env. Never print it.
