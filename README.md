# lucida-api

A small Fastify + TypeScript HTTP API that does what
[`lucida-downloader`](https://github.com/jelni/lucida-downloader) does, but streams the audio back over
HTTP instead of writing it to disk. Amazon Music only: give it a track URL and
it streams the audio back.

Requests are validated with [zod](https://zod.dev), and the same schemas
generate the OpenAPI document.

## running

The whole stack, API plus challenge solver:

```
docker compose up -d
```

Or run the API directly, with a solver of your own alongside it:

```
docker run -d -p 8191:8191 --shm-size=2gb ghcr.io/thephaseless/byparr
npm install
npm run dev        # node --watch src/server.ts
npm run build && npm start
```

Environment:

| variable                | default     | purpose                                                        |
| ----------------------- | ----------- | -------------------------------------------------------------- |
| `PORT`                  | `3000`      | listen port                                                    |
| `HOST`                  | `127.0.0.1` | listen address                                                 |
| `SOLVER_URL`            | `http://127.0.0.1:8191` | where the challenge solver listens                 |
| `CLEARANCE_TIMEOUT_MS`  | `60000`     | how long the solver may spend clearing the challenge           |
| `CF_CLEARANCE`          | —           | escape hatch: use a cookie of your own instead of the solver   |
| `USER_AGENT`            | —           | the `User-Agent` that cookie was issued to                     |

## the captcha

Cloudflare guards lucida.to, so on boot the server asks
[Byparr](https://github.com/ThePhaseless/Byparr) to fetch lucida.to and hand
back the `cf_clearance` cookie it was issued. That cookie and the solver's
User-Agent are then attached to every plain HTTP request the API makes.

Byparr drives a stealth Firefox ([Camoufox](https://github.com/daijro/camoufox))
and speaks the FlareSolverr API, so any drop-in replacement works — point
`SOLVER_URL` at it instead. The engine matters: Chromium-based solvers clear
this challenge on a desktop but not from inside a container, whereas the Firefox
engine clears it in both.

A `cf_clearance` cookie is bound to the User-Agent it was issued to, so the two
always travel together.

Any request that comes back 403 means the clearance went stale: the session asks
for a fresh solve once and retries automatically. Concurrent callers share a
single in-flight solve rather than each starting their own.

Setting **both** `CF_CLEARANCE` and `USER_AGENT` skips the solver entirely and
uses those values instead.

## docs

With the server running, Swagger UI is at `/docs` and the OpenAPI 3.0 document
at `/docs/json`.

## endpoints

### `GET /health`

Returns `{"status": "available" | "captcha" | "unavailable"}`. `captcha` means
the clearance cookie is not working — check the startup logs.

### `GET /search`

**Temporarily disabled.** Answers 503:

```json
{ "error": "search is temporarily disabled; pass a track URL to /download instead" }
```

Amazon stopped issuing anonymous catalogue tokens, so querying its catalogue
directly now answers every search with a "Service error". Searching through
lucida instead worked, but capped at ten results per query and went down often
enough that it was not worth keeping. The endpoint stays registered so callers
get a clear answer rather than a 404 to interpret.

Find the track URL yourself and pass it to `/download`.

### `GET /download?url=<amazon track url>`

Resolves the track, asks lucida to prepare it, waits for it to finish, then
pipes the audio through with `Content-Type`, `Content-Length` (when lucida sends
one), and a `Content-Disposition` filename matching the downloader's naming
(`Artist - Title.flac`). Nothing is buffered or written to disk.

This endpoint takes an Amazon Music **track** URL; an album or playlist URL
returns 400.

A transfer that dies halfway is picked back up rather than failing. lucida's
servers close the connection mid-file often enough on a long track that the
client would otherwise see a truncated body, and the handoff cannot be re-read:
it 404s the moment its download connection ends. So the track is re-ripped and
`Range` fast-forwards the new transfer to the byte the old one reached. Two rips
of the same track are byte-identical; the last 64KB already sent is re-fetched
and compared against the new one, and a mismatch fails the request instead of
stitching a corrupt file. The client sees one continuous response the whole
time, just with a pause in it while the re-rip happens. Three resumes per
request, after which the failure is passed on.

Query parameters:

| parameter  | default    | purpose                                                     |
| ---------- | ---------- | ----------------------------------------------------------- |
| `country`  | `auto`     | country to use lucida accounts from                         |
| `metadata` | `true`     | let lucida embed metadata in the file                       |
| `server`   | —          | pin the rip to one lucida server (e.g. `maus`)              |
| `private`  | `false`    | hide the track from lucida's recent downloads               |

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, and `on`/`off`. An invalid
value gets a 400 naming the offending parameter.

### speed

Most of the wall clock is lucida's, not this server's, and two parameters move
it a lot:

- `metadata=false` skips lucida's metadata step. That step queues ("Waiting for
  slot to open to add metadata..."), and lucida drops handoffs that sit in that
  queue too long, which then costs a full retry.
- lucida's `mp3` conversion is advertised in its UI but its API rejects it
  (`FFMPEG error: Invalid downscaling option`), so downloads are always in the
  original format. A long hi-res FLAC runs to ~160 MB.

## differences from `lucida-downloader`

- one track per request; no album directories, no cover download, no workers,
  and no album or playlist resolution
- Amazon Music only; the downloader's other services and their special cases
  are not carried over
- retries are bounded (5 attempts; 5min cap on preparing a track) instead of
  looping forever, so a request always terminates. Otherwise the retry
  behaviour matches the downloader's `'request_track_download` loop: a dropped
  handoff (404/500) or a failed audio fetch means "ask lucida for a new
  handoff", not "give up". A status that stops changing is *not* treated as a
  wedge — lucida reports no progress, and `ripping` holds one fixed message for
  as long as the rip takes, so the 5min cap is the only time-based backstop
- a page payload that will not parse is retried like any other transient
  page error rather than surfacing as a 500
- a transfer dropped mid-file is resumed against a fresh rip with `Range`, so
  the client gets a whole file rather than a truncated one
- disconnecting the client aborts the upstream lucida requests
- the Cloudflare challenge is solved by a browser at boot, in a sidecar
  container, instead of asking you to paste a cookie in by hand
- an unrecognised audio MIME type is a 502 rather than a panic
