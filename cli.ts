#!/usr/bin/env bun
// seek: web search and page fetch through Vercel AI Gateway's DeepSeek tools.
// The tools only run as gateway server tools called by a model, so we let the
// cheapest host model make exactly one tool call and print the tool's own raw
// result (not the model's retelling).
import { generateText, jsonSchema, stepCountIs } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createProviderExecutedToolFactory } from "@ai-sdk/provider-utils";
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODEL = "zai/glm-5.3-flash"; // cheapest tool-calling host; fixed on purpose
const SEARCH_TTL_MS = 3_600_000; // search results and their answers: 1 hour
const FETCH_TTL_MS = 86_400_000; // fetched pages and their answers: 1 day

const USAGE = `seek - web search and page fetch via Vercel AI Gateway (DeepSeek tools)

Usage:
  seek search <query...> [filters] [--question "Q" [--answer-only]] [--count N] [--content] [--json] [--no-cache]
  seek fetch <url> [--question "Q" [--answer-only]] [--max-chars N] [--json] [--no-cache]
  seek install         symlink the bundled skill into ~/.claude/skills/seek-search

Search filters (each becomes a search operator; repeatable ones marked *):
  --site D*          only this site/domain            site:D (several = OR)
  --exclude-site D*  drop this site                   -site:D
  --phrase "P"*      must contain exact phrase        "P"
  --exclude W*       drop results with word/phrase    -W  /  -"W W"
  --lang L*          languages, e.g. en, de, zh       lang:en,de
  --after DATE       published after  (YYYY or YYYY-MM-DD)
  --before DATE      published before (YYYY or YYYY-MM-DD)
  --question "Q"     also answer Q from the results: a short cited answer
                     first, then the results (also improves ranking)
You can also write operators straight into the query. Query max 128 chars.

Other:
  --count N      results, 1-50 (default 10)
  --content      include full page content per result (long)
  --max-chars N  fetch: truncate printed content to N chars
  --question "Q" fetch: answer Q from the page first, then the page
  --answer-only  with --question (search or fetch): print only the answer
  --no-cache     skip the local cache (~/.cache/seek; search 1h, fetch 1d, answers too)
  --json         raw JSON from the tool instead of Markdown

Env: SEEK_SEARCH_GATEWAY_KEY (required)`;

function fail(msg: string, code = 1): never {
  console.error(`seek: ${msg}`);
  process.exit(code);
}

// --- args ---
const VALUE = new Set(["count", "site", "exclude-site", "phrase", "exclude", "lang", "after", "before", "question", "max-chars"]);
const BOOL = new Set(["json", "content", "answer-only", "no-cache"]);
const opts: Record<string, string[]> = {};
const bools: Record<string, boolean> = {};
const positional: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
  if (!a.startsWith("--")) { positional.push(a); continue; }
  const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
  if (BOOL.has(name)) bools[name] = true;
  else if (VALUE.has(name)) {
    const v = inline ?? argv[++i];
    if (v === undefined) fail(`--${name} needs a value`, 2);
    (opts[name] ??= []).push(v);
  } else fail(`unknown option --${name}\n\n${USAGE}`, 2);
}
const one = (k: string) => opts[k]?.at(-1);
const many = (k: string) => opts[k] ?? [];

const [command, ...rest] = positional;
if (!command) { console.log(USAGE); process.exit(2); }
if (command === "install") {
  // Symlink the bundled skill, so it updates with the package.
  const src = join(import.meta.dir, "skill");
  const dest = join(homedir(), ".claude", "skills", "seek-search");
  let existing;
  try { existing = lstatSync(dest); } catch {}
  if (existing && !existing.isSymbolicLink()) fail(`${dest} exists and is not a symlink; remove it first`);
  if (existing) unlinkSync(dest);
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(src, dest);
  console.log(`linked ${dest} -> ${src}`);
  process.exit(0);
}
if (command !== "search" && command !== "fetch") fail(`unknown command "${command}"\n\n${USAGE}`, 2);

const apiKey = process.env.SEEK_SEARCH_GATEWAY_KEY;
if (!apiKey) fail("SEEK_SEARCH_GATEWAY_KEY is not set");
const gateway = createGateway({ apiKey });
// @ai-sdk/gateway ships no DeepSeek helpers, but the gateway executes these ids.
const gatewayTool = (id: string, input: Record<string, unknown>) =>
  createProviderExecutedToolFactory<any, any, any>({
    id,
    inputSchema: jsonSchema({ type: "object", properties: input, required: Object.keys(input) }),
    outputSchema: jsonSchema({}),
  });
const deepseekSearch = gatewayTool("gateway.deepseek_search", { query: { type: "string" } });
const deepseekFetch = gatewayTool("gateway.deepseek_fetch", { url: { type: "string" } });

const date = (k: string) => {
  const v = one(k);
  if (v && !/^\d{4}(-\d{2}-\d{2})?$/.test(v)) fail(`--${k} must be YYYY or YYYY-MM-DD`, 2);
  return v;
};
const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

// One plain model call that answers only from the given material.
async function answer_(question: string, kind: string, rules: string, material: string) {
  const system =
    `You answer a question using only the ${kind} given. Reply in at most 5 sentences. ${rules} ` +
    `If the ${kind} doesn't answer it, say so plainly in one sentence. No preamble, no guessing beyond the ${kind}.`;
  // stable prefix first (system, then material), question last, so providers can reuse cached prefixes
  const prompt = `${material}\n\nQuestion: ${question}`;
  // keyed by everything the model sees, so any change to model, prompt, source or question misses
  return cached(["answer", MODEL, system, prompt], async () => {
    const { text, usage } = await generateText({ model: gateway(MODEL), system, prompt, reasoning: "low", maxOutputTokens: 400 });
    if (process.env.SEEK_DEBUG) console.error(`seek: answer usage ${JSON.stringify(usage)}`);
    return text.trim();
  });
}

// Raw tool results cached on disk, keyed by tool + exact params.
const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "seek");
async function cached<T>(key: unknown, run: () => Promise<T>): Promise<T> {
  const file = join(cacheDir, new Bun.CryptoHasher("sha256").update(JSON.stringify(key)).digest("hex") + ".json");
  if (!bools["no-cache"]) {
    try {
      if (Date.now() - statSync(file).mtimeMs < (command === "search" ? SEARCH_TTL_MS : FETCH_TTL_MS)) return JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  const value = await run();
  try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify(value)); } catch {}
  return value;
}

async function runTool(name: string, tool: any, prompt: string) {
  const result = await generateText({
    model: gateway(MODEL),
    tools: { [name]: tool },
    toolChoice: "required",
    reasoning: "none", // the tool call needs no thinking
    stopWhen: stepCountIs(1), // one tool call, no model write-up afterwards
    prompt,
  });
  const parts = result.steps.flatMap((s: any) => s.content);
  const err = parts.find((p: any) => p.type === "tool-error");
  if (err) fail(`${name} failed: ${String((err as any).error?.message ?? (err as any).error)}`);
  const res = parts.find((p: any) => p.type === "tool-result");
  if (!res) fail(`${name} returned no result`);
  return (res as any).output;
}

if (command === "search") {
  const terms = [rest.join(" ").trim()];
  const sites = many("site");
  if (sites.length) terms.push(sites.map((s) => `site:${s}`).join(" OR "));
  for (const s of many("exclude-site")) terms.push(`-site:${s}`);
  for (const p of many("phrase")) terms.push(`"${p}"`);
  for (const w of many("exclude")) terms.push(`-${quote(w)}`);
  const langs = many("lang").flatMap((l) => l.split(","));
  if (langs.length) terms.push(`lang:${langs.join(",")}`);
  const after = date("after"), before = date("before");
  if (after) terms.push(`after:${after}`);
  if (before) terms.push(`before:${before}`);
  const query = terms.filter(Boolean).join(" ");
  if (!query) fail("search needs a query or filters", 2);
  if ([...query].length > 128) fail(`query is ${[...query].length} chars, max 128: ${query}`, 2);
  const count = one("count") ? Number(one("count")) : 10;
  if (!Number.isInteger(count) || count < 1 || count > 50) fail("--count must be 1-50", 2);
  const question = one("question")?.slice(0, 128);
  if (bools["answer-only"] && !question) fail("--answer-only needs --question", 2);

  const params = { query, count, needContent: !!bools.content, ...(question ? { oriQuestion: question } : {}) };
  const output = await cached(["search", params], () =>
    runTool("deepseek_search", deepseekSearch(params), `Search the web for: ${query}`));
  const results: any[] = output?.results ?? [];
  let answer: string | undefined;
  if (question && results.length) {
    const sources = results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.date ?? ""}\n${(r.content || r.summary || r.snippet || "").slice(0, 4000)}`)
      .join("\n\n");
    answer = await answer_(question, "numbered search results",
      "Cite sources as [n] after each claim. If they don't answer it, also name the result(s) most worth fetching.",
      `Search results:\n\n${sources}`);
  }
  if (bools["answer-only"] && question) console.log(answer ?? "No results.");
  else if (bools.json) {
    console.log(JSON.stringify({ query, ...(question ? { question, answer: answer ?? null } : {}), count: results.length, results }, null, 2));
  } else {
    const lines: string[] = [];
    if (answer) lines.push(`# Answer: ${question}`, answer, "", "---", "");
    lines.push(`# Search: ${query}`, `${results.length} result${results.length === 1 ? "" : "s"}`, "");
    results.forEach((r, i) => {
      const meta = [r.site_name ?? r.siteName, r.date?.slice(0, 10)].filter(Boolean).join(" · ");
      lines.push(`## ${i + 1}. ${r.title || r.url}`, r.url);
      if (meta) lines.push(meta);
      lines.push("", (r.snippet || r.summary || "").trim());
      if (r.content) lines.push("", "<content>", r.content.trim(), "</content>");
      lines.push("");
    });
    if (!results.length) lines.push("No results. Loosen the filters or rephrase.");
    console.log(lines.join("\n"));
  }
} else {
  const url = rest[0];
  if (!url || rest.length > 1) fail("fetch needs exactly one url", 2);
  let u: URL;
  try { u = new URL(url); } catch { fail(`not a valid URL: ${url}`, 2); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || url.length > 8192) fail("url must be http(s), with a host, no credentials, at most 8192 chars", 2);
  const max = one("max-chars") ? Number(one("max-chars")) : undefined;
  if (max !== undefined && (!Number.isInteger(max) || max < 1)) fail("--max-chars must be a positive integer", 2);

  const question = one("question")?.slice(0, 500);
  if (bools["answer-only"] && !question) fail("--answer-only needs --question", 2);

  const output = await cached(["fetch", url], () => runTool("deepseek_fetch", deepseekFetch({ url }), `Fetch ${url}`));
  const full: string = output?.content ?? "";
  if (!full) fail("page had no usable content (blocked or empty)");
  const title: string = output?.title ?? "";
  // ponytail: model sees the first 100k chars only; chunk if long pages matter
  const ans = question
    ? await answer_(question, "web page", "Quote or name the section heading the answer comes from.",
        `Page: ${title}\n${url}\n\n${full.slice(0, 100_000)}`)
    : undefined;
  const truncated = max !== undefined && full.length > max;
  const content = truncated ? full.slice(0, max) : full;
  if (bools["answer-only"]) console.log(ans);
  else if (bools.json) console.log(JSON.stringify({ url, title, ...(question ? { question, answer: ans } : {}), truncated, content }, null, 2));
  else {
    const head = ans ? `# Answer: ${question}\n${ans}\n\n---\n\n` : "";
    console.log(`${head}${title ? `# ${title}\n${url}\n\n` : `${url}\n\n`}${content}${truncated ? "\n\n[truncated]" : ""}`);
  }
}
