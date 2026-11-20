# Netlify app

This is a separate Node.js deployment for Netlify. The original Python application remains in
`../src/startup_voice`; the build copies its browser UI into this folder's `dist/` output. The API
is one regular **Netlify Function** (`netlify/functions/api.mjs`, routed from `/api/*` and `/health`),
so it deploys on every plan. (An earlier version used the "Netlify Server" runtime, which only exists
on credit-based plans and made the build fail with "Netlify Server is only available on credit-based
plans".)

## Netlify setup

In the Netlify site settings, set **Base directory** to `netlify-app` and branch `main`. Leave
Build command / Publish directory empty (or `npm run build` / `dist`): the included `netlify.toml`
selects Node 24, runs `npm run build`, publishes `dist`, and bundles `netlify/functions/`.

Set these environment variables in the Netlify site settings before deploying:

| Variable | Required | Example |
|---|---:|---|
| `LLM_PROVIDER` | for a server model | `scaleway` or `openai_compatible`. Unset = no server model: Settings disables it and the browser (WebGPU) model is used |
| `SCW_SECRET_KEY` / `SCW_PROJECT_ID` | `scaleway` | Scaleway IAM key / project id (endpoint `https://api.scaleway.ai/<id>/v1`) |
| `LLM_MODEL` | `openai_compatible` | Model id; for `scaleway` optional (default `deepseek-v4.1-flash-1017`) |
| `LLM_BASE_URL` / `LLM_API_KEY` | `openai_compatible` | Endpoint and key. No OpenAI / Netlify AI Gateway fallback (`OPENAI_*` is ignored) |
| `ELEVENLABS_API_KEY` | no | Enables server-generated spoken replies and cloud speech recognition |
| `ELEVENLABS_VOICE_ID` | TTS only | Voice ID from ElevenLabs |
| `IDO_ORIGINS` | only when embedded | Comma-separated trusted ido-core origins |

Session and prompt settings use site-wide Netlify Blobs in Frankfurt, so they survive deploys and
do not depend on the server instance's temporary filesystem. `npm run dev` starts the Netlify local
development environment; local data is stored in the ignored `.local-data/` folder.

The Netlify version keeps the interview, dossier, session management, PDF/Markdown/JSON export,
browser speech recognition, and optional ElevenLabs speech input/output. LiveKit is not included:
its current voice mode relies on a separate always-running worker, which this Netlify app does not
host. The Node server does not probe the LLM at startup, but `/health` reports provider `none` when
the config is incomplete, so Settings disables the server model instead of failing on the first
turn; a turn against it answers 503 with the missing variable names.
Function time limits of your plan apply to one interview turn (reply + dossier update).

## Deploy steps

1. Install dependencies in this folder with `npm install`.
2. In Netlify, connect this repository and set the base directory to `netlify-app`.
3. For a server reply model set `LLM_PROVIDER=scaleway` + `SCW_SECRET_KEY` + `SCW_PROJECT_ID`
   (or `openai_compatible` + `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL`) as runtime environment
   variables. Without them the app runs with the browser (WebGPU) model only.
4. Deploy. No special server runtime is needed.
