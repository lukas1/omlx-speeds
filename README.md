# omlx-speeds (pi extension)

Live prompt-processing (PP) and token-generation (TG) speeds, plus a prompt
timer, for [oMLX](https://github.com/jundot/omlx)-backed models in
[pi](https://github.com/badlogic/pi-mono).

While pi waits for or receives a model response, the extension polls the
oMLX admin activity endpoint once per second and shows, in the working
loader line:

- **Prompt phase:** `prompt 3.2s · PP 412 t/s · ~4s left · 12.3k/16.5k tok`
  (the seconds value is server-side prefill elapsed time)
- **Generation:** `gen 12.4s · TG 34 t/s · 421 tok`
- **Queued:** `queued 2.1s`

The last summary stays visible in the footer status when idle. If the admin
API is unreachable, a client-side timer (turn start → now) is shown instead.

## Install

```bash
pi install git:github.com/lukas1/omlx-speeds
```

Or manually: copy `index.ts` into `~/.pi/agent/extensions/`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OMLX_URL` | `http://127.0.0.1:8000` | oMLX server base URL |
| `OMLX_API_KEY` | `auth.api_key` from `~/.omlx/settings.json` | Main oMLX API key (admin API) |

## Notes

- PP speed only resolves for prefills that span more than one chunk; very
  short or fully cached prompts finish in a single chunk and report `0`.
- Requests are attributed to pi via the `X-oMLX-Request-ID` response header,
  so other clients on the same server do not skew the numbers.
