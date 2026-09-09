# lucida-api

A small Fastify + TypeScript HTTP API that does what
[`lucida-downloader`](https://github.com/jelni/lucida-downloader) does, but streams the audio back over
HTTP instead of writing it to disk. Amazon Music only: search for a track by
artist and title, then stream it.

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

### `GET /search?artist=<artist>&track=<title>`

Finds tracks on Amazon Music and returns up to five, most likely first, so you
can pick between an album version, a live take and a radio edit rather than
having one guessed for you. Both parameters are required:

```json
[
  {
    "id": "B0FM5VWYKJ",
    "title": "Timeland",
    "artist": "King Gizzard & The Lizard Wizard",
    "url": "https://music.amazon.com/tracks/B0FM5VWYKJ"
  }
]
```

Any `url` goes straight into `/download`. Tracks only. The same
recording appears under several releases with different ids, so results are
collapsed on title and artist — genuine variants stay as separate choices. A query with
no hits on the US marketplace is retried across the other Amazon marketplaces,
whose catalogue indexes differ, before returning 404.

Amazon ranks its own results by artist relevance and largely ignores the title,
so a search tends to return that artist's most popular track rather than the one
asked for — the requested song is often several places down the list. Results
are therefore re-scored locally, matching each parameter against the field it
belongs to. Keeping the two apart is what stops a `"<title> (<artist> Cover)"`
by somebody else from outranking the original, since a cover puts the real
artist's name in its own title. A result sharing no word with `track` is
rejected outright rather than returned as a near-miss.

**Both sides must match, or nothing is returned.** A result qualifies only when
every word of `track` appears in its title and every identifying word of
`artist` appears in its artist — a near-miss is discarded rather than handed
back. Two things this rules out: Amazon answers a query it cannot satisfy with
the artist's most popular songs, and sharing one generic word is not the same
act, so `artist=Daft Punk` will not match "Piano Punk". Leading articles are
ignored, so `The Beatles` still matches "Beatles".

When the combined search finds nothing, the title is searched on its own —
pairing the two can drown it, and `artist=Daft Punk&track=Musique` returns Daft
Punk's ten best-known songs, none of them "Musique", while the title alone finds
it first. The same both-sides rule applies to that pass.

A `feat.` / `ft.` / `featuring` credit in `track` is matched against **either**
field, because releases file it under either one: Amazon lists "Coming up Low"
with its guests in the artist rather than the title, so requiring them in the
title would never match. The title proper still has to be in the title.

Accents are folded before comparison, so `Bjork` matches "Björk" and
`Motorhead` matches "Motörhead", on both sides of the comparison.

Titles advertising a different *kind* of recording — live, commentary, karaoke,
radio edit, remix and so on — are demoted, because those carry the real title
and the real artist and nothing else in the score tells them apart. Searching
King Crimson's "21st Century Schizoid Man" returns ten variants and no plain
studio version, and the spoken-word commentary track has the tidiest title of
them all. Markers named in `track` are not penalised, so asking for
`track=21st Century Schizoid Man (Live)` still gets the live take.

### `GET /download?url=<amazon track url>`

Resolves the track, asks lucida to prepare it, waits for it to finish, then
pipes the audio through with `Content-Type`, `Content-Length` (when lucida sends
one), and a `Content-Disposition` filename matching the downloader's naming
(`Artist - Title.flac`). Nothing is buffered or written to disk.

This endpoint takes an Amazon Music **track** URL, the kind `/search` returns;
an album or playlist URL returns 400.

Query parameters:

| parameter  | default    | purpose                                                     |
| ---------- | ---------- | ----------------------------------------------------------- |
| `country`  | `auto`     | country to use lucida accounts from                         |
| `metadata` | `true`     | let lucida embed metadata in the file                       |
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
  handoff (404/500), a status that stops changing for 30s, or a failed audio
  fetch all mean "ask lucida for a new handoff", not "give up"
- a page payload that will not parse is retried like any other transient
  page error rather than surfacing as a 500
- disconnecting the client aborts the upstream lucida requests
- the Cloudflare challenge is solved by a browser at boot, in a sidecar
  container, instead of asking you to paste a cookie in by hand
- an unrecognised audio MIME type is a 502 rather than a panic
