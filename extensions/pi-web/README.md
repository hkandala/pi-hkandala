# pi-web

`web_search` and `web_fetch` tools for pi, backed by [TinyFish](https://docs.tinyfish.ai/)'s Search and Fetch APIs, which are free at any balance. Search also needs Search API access on the account. Without it, `web_search` fails with HTTP 402.

- **`web_search`** returns about 10 results per page (title, URL, date, snippet) inline. With `includeContent`, it also fetches every result page to files (as `web_fetch` does with several URLs) and lists their paths, so the agent can search once and then grep and read.
- **`web_fetch`** fetches pages live as clean markdown (JavaScript rendered, PDF text extracted) and saves each one to a file. Each call gets a new private folder, `$TMPDIR/pi-web-<time>-<random>/` (`/tmp` when `$TMPDIR` is not set). pi-web never deletes these files; the operating system cleans its temp folder. The file holds the full text, then `## Links` and `## Images` sections listing every link and image URL on the page. TinyFish's markdown drops links and images, so the lists are the only place to find them. The agent greps them, or downloads an image with `curl` and reads it. `web_fetch` cannot fetch an image URL itself.
  - **One URL:** a preview of the page (by default the first 1000 lines or 25KB) plus the file path.
  - **Several URLs:** only the file paths with titles and sizes, so fetching many pages to grep or script over costs almost no context.

## Install

```bash
pi install npm:@hkandala/pi-web
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-web`.

Then get a free API key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys) and either export it as `TINYFISH_API_KEY` or save it with the TinyFish CLI (pi-web reads `~/.tinyfish/config.json`):

```bash
npm install -g @tiny-fish/cli && tinyfish auth login
```

## Tools

`web_search`:

| Parameter        | Default   | Meaning                                                            |
| ---------------- | --------- | ------------------------------------------------------------------ |
| `query`          | required  | Search query                                                       |
| `domains`        | all sites | Only search these domains; prefix one with `-` to exclude it       |
| `recency`        | any time  | `day`, `week`, `month`, or `year`                                  |
| `type`           | `web`     | `web`, `news`, or `research_paper` (adds authors, venue, PDF, ...) |
| `page`           | `0`       | Result page, `0` to `10`                                           |
| `includeContent` | `false`   | Also fetch all result pages to files and list their paths          |

`web_fetch`:

| Parameter | Default  | Meaning                                                               |
| --------- | -------- | --------------------------------------------------------------------- |
| `urls`    | required | 1 to 10 URLs, fetched in parallel. One URL gets a preview, more don't |

## Configuration

`~/.pi/agent/extensions/pi-web.json`. All keys are optional:

| Key               | Default | Meaning                                            |
| ----------------- | ------- | -------------------------------------------------- |
| `maxPreviewLines` | `1000`  | Most lines of the single-URL fetch preview         |
| `maxPreviewBytes` | `25600` | Most bytes of the single-URL fetch preview         |
| `timeoutSeconds`  | `30`    | Per-URL fetch timeout (max 110) and search timeout |

Run `/reload` after editing.

## Notes

- Queries and URLs are sent to TinyFish, which does the fetching; nothing is fetched locally.
- Fetches always ask for a live page (`ttl: 0`). TinyFish's default serves cached copies of any age.
- A URL that times out or fails is listed under `Errors:` without failing the rest of the batch.
- `type: "news"` combined with `domains` loses the news dates and publishers and can return non-news pages (a TinyFish limitation). `recency` works with news.
- Rate limits: search 30 requests/minute, fetch 150 URLs/minute. The rate-limit error tells the agent to fall back to `curl` until it resets.
- For more than 10 URLs or raw JSON, the `tinyfish` CLI (`tinyfish search query`, `tinyfish fetch content get`) uses the same key.
