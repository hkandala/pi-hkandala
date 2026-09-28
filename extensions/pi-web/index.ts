/**
 * pi-web: web_search and web_fetch tools backed by TinyFish (free Search and Fetch APIs).
 *
 * The API key comes from TINYFISH_API_KEY, else from ~/.tinyfish/config.json (written by
 * `tinyfish auth login`). Fetches are always live and every page (markdown plus its link and image
 * URLs) is saved to a file. Only a single-URL web_fetch previews the page inline; everything else
 * returns file paths. Limits come from ~/.pi/agent/extensions/pi-web.json.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  formatSize,
  getAgentDir,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const FETCH_URL = "https://api.fetch.tinyfish.ai";
const RECENCY_MINUTES = { day: 1440, week: 10080, month: 43200, year: 525600 };
const HTTP_ERRORS: Record<number, string> = {
  401: "invalid TinyFish API key",
  402: "this TinyFish account has no Search API access",
  429: "TinyFish rate limit exceeded (search 30/min, fetch 150 URLs/min). Until it resets, fall back to curl (e.g. curl -sL <url>)",
};

type Page = {
  url: string;
  title: string;
  date?: string;
  text: string;
  path: string;
  stats: string;
};

function readJson(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function tinyfish(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  ms: number,
) {
  const key =
    process.env.TINYFISH_API_KEY || readJson(join(homedir(), ".tinyfish", "config.json")).api_key;
  if (!key)
    throw new Error("No TinyFish API key. Set TINYFISH_API_KEY or run `tinyfish auth login`.");
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError")
      throw new Error(`TinyFish timed out after ${ms / 1000}s`);
    throw err;
  }
  if (!res.ok) {
    const reason =
      HTTP_ERRORS[res.status] ?? (res.status >= 500 ? "TinyFish is unavailable, try again" : "");
    // JSON error bodies explain the failure; HTML ones (CDN error pages) are noise.
    const body = res.headers.get("content-type")?.includes("json")
      ? (await res.text()).slice(0, 300)
      : "";
    throw new Error(`TinyFish HTTP ${res.status}${reason ? `: ${reason}` : ""}\n${body}`);
  }
  return res.json();
}

export default function (pi: ExtensionAPI) {
  const {
    maxPreviewLines = 1000,
    maxPreviewBytes = 25 * 1024,
    timeoutSeconds = 30,
  } = readJson(join(getAgentDir(), "extensions", "pi-web.json"));
  const timeoutMs = timeoutSeconds * 1000;

  // Fetches up to 10 URLs live and saves each page to its own file in a fresh temp directory.
  async function fetchPages(urls: string[], signal: AbortSignal | undefined) {
    const body = {
      urls,
      format: "markdown",
      ttl: 0,
      links: true,
      image_links: true,
      per_url_timeout_ms: Math.min(timeoutMs, 110_000),
    };
    const data = await tinyfish(
      FETCH_URL,
      { method: "POST", body: JSON.stringify(body) },
      signal,
      timeoutMs + 10_000,
    );

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const dir = join(tmpdir(), "pi-web", `${stamp}-${randomBytes(3).toString("hex")}`);
    mkdirSync(dir, { recursive: true });

    const pages: Page[] = (data.results ?? []).map((r: any, i: number) => {
      const url: string = r.final_url || r.url;
      const title: string = r.title || url;
      const text: string = (r.text ?? "").trim();
      const links: string[] = r.links ?? [];
      const images: string[] = r.image_links ?? [];
      const file = [
        `# ${title}`,
        `URL: ${url}`,
        ...(r.published_date ? [`Published: ${r.published_date}`] : []),
        "",
        text,
        ...(links.length ? ["", "## Links", "", ...links.map((l) => `- ${l}`)] : []),
        ...(images.length ? ["", "## Images", "", ...images.map((l) => `- ${l}`)] : []),
        "",
      ].join("\n");
      const slug = url
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80);
      const path = join(dir, `${String(i + 1).padStart(2, "0")}-${slug}.md`);
      writeFileSync(path, file);
      const lines = file.split("\n").length - 1;
      const stats = `${formatSize(Buffer.byteLength(file))}, ${lines} lines, ${links.length} links, ${images.length} images`;
      return { url, title, date: r.published_date, text, path, stats };
    });
    const errors: string[] = (data.errors ?? []).map(
      (e: any) => `- ${e.url}: ${e.error}${e.status ? ` (${e.status})` : ""}`,
    );

    const listing = [
      `Saved to ${dir}/`,
      ...pages.map(
        (p, i) => `${i + 1}. ${p.path.slice(dir.length + 1)} — "${p.title}", ${p.stats}`,
      ),
      ...(errors.length ? ["Errors:", ...errors] : []),
    ].join("\n");
    return { pages, errors, listing };
  }

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Returns about 10 results per page, each with title, URL, date, and snippet. Set includeContent to also fetch every result page into markdown files (see web_fetch) and list their paths, so you can grep and read them.",
    promptSnippet: "Search the web",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only search these domains; prefix a domain with - to exclude it instead",
        }),
      ),
      recency: Type.Optional(
        StringEnum(["day", "week", "month", "year"], { description: "Only recent results" }),
      ),
      type: Type.Optional(
        StringEnum(["web", "news", "research_paper"], {
          description: "Kind of results (default web)",
        }),
      ),
      page: Type.Optional(
        Type.Integer({ minimum: 0, maximum: 10, description: "Result page, from 0 (default 0)" }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({ description: "Also fetch all result pages to files (default false)" }),
      ),
    }),

    async execute(_id, params, signal) {
      const q = new URLSearchParams({ query: params.query });
      const domains = params.domains?.map((d) => d.trim()).filter(Boolean) ?? [];
      const include = domains.filter((d) => !d.startsWith("-"));
      const exclude = domains.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
      if (include.length) q.set("include_domains", include.join(","));
      if (exclude.length) q.set("exclude_domains", exclude.join(","));
      if (params.recency) q.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
      if (params.type) q.set("domain_type", params.type);
      if (params.page) q.set("page", String(params.page));

      const results: any[] =
        (await tinyfish(`${SEARCH_URL}?${q}`, {}, signal, timeoutMs)).results ?? [];
      let text =
        results
          .map((r, i) => {
            const meta = [r.date, r.publisher].filter(Boolean).join(", ");
            const paper = [
              r.authors?.join(", "),
              r.venue,
              r.year,
              r.cited_by_count != null && `cited by ${r.cited_by_count}`,
              r.pdf_url && `PDF: ${r.pdf_url}`,
            ].filter(Boolean);
            return [
              `${i + 1}. ${r.title} — ${r.url}${meta ? ` (${meta})` : ""}`,
              r.snippet && `   ${r.snippet}`,
              paper.length > 0 && `   ${paper.join(" · ")}`,
            ]
              .filter(Boolean)
              .join("\n");
          })
          .join("\n\n") || "No results.";
      if (params.includeContent && results.length) {
        const urls = [...new Set(results.map((r) => r.url as string))].slice(0, 10);
        // A failed fetch shouldn't lose the search results.
        const fetched = await fetchPages(urls, signal).then(
          (f) => f.listing,
          (err) => `Fetching the result pages failed: ${err.message}`,
        );
        text += `\n\n${fetched}`;
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch web pages live as clean markdown (renders JavaScript, extracts PDF text; image URLs are not supported). Every page is saved to a markdown file: the full text, then "## Links" and "## Images" sections listing every link and image URL on the page (grep them; download images with curl and read them). With one URL, returns a preview (first ${maxPreviewLines} lines or ${formatSize(maxPreviewBytes)}) plus the file path. With several URLs, returns only the file paths with titles and sizes; read or grep the files.`,
    promptSnippet: "Fetch web pages as markdown files",
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 10,
        description: "URLs to fetch (1-10)",
      }),
    }),

    async execute(_id, params, signal) {
      const { pages, errors, listing } = await fetchPages(params.urls, signal);
      if (pages.length === 0) throw new Error(`Fetch failed:\n${errors.join("\n")}`);
      if (params.urls.length > 1)
        return { content: [{ type: "text", text: listing }], details: undefined };

      const p = pages[0];
      const t = truncateHead(p.text, { maxLines: maxPreviewLines, maxBytes: maxPreviewBytes });
      // The file starts with "# title", "URL:", maybe "Published:", and a blank line before the text.
      const offset = (p.date ? 4 : 3) + t.outputLines + 1;
      let text = `# ${p.title}\n${[p.url, p.date].filter(Boolean).join(" · ")}\n\n${t.content}\n\nSaved: ${p.path} (${p.stats})`;
      if (t.truncated)
        text += `\n[Preview truncated at ${t.outputLines} of ${t.totalLines} lines (limit ${maxPreviewLines} lines or ${formatSize(maxPreviewBytes)}). Continue with read offset ${offset}, or grep the file.]`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
}
