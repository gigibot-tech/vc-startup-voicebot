# Netlify app

This is a separate Node.js deployment for Netlify. The original Python application remains in
`../src/startup_voice`; the build copies its browser UI into this folder's `dist/` output. The
Netlify server implementation and storage adapter live under `netlify/`.

## Netlify setup

In the Netlify site settings, set **Base directory** to `netlify-app`. The included `netlify.toml`
then selects Node 24, runs `npm run build`, publishes `dist`, and discovers the server at
`netlify/server/index.mjs`.

Set these environment variables in the Netlify site settings before deploying:

| Variable | Required | Example |
|---|---:|---|
| `LLM_API_KEY` | no | Own key for an OpenAI-compatible model endpoint; otherwise Netlify AI Gateway can supply the OpenAI-compatible key/base URL |
| `LLM_BASE_URL` | no | Custom OpenAI-compatible endpoint; otherwise the Netlify AI Gateway URL or OpenAI URL is used |
| `LLM_MODEL` | no | Model supported by the selected endpoint; default `gpt-4o-mini` |
| `ELEVENLABS_API_KEY` | no | Enables server-generated spoken replies and cloud speech recognition |
| `ELEVENLABS_VOICE_ID` | TTS only | Voice ID from ElevenLabs |
| `IDO_ORIGINS` | only when embedded | Comma-separated trusted ido-core origins |

Session and prompt settings use site-wide Netlify Blobs in Frankfurt, so they survive deploys and
do not depend on the server instance's temporary filesystem. `npm run dev` starts the Netlify local
development environment; local data is stored in the ignored `.local-data/` folder.

The Netlify version keeps the interview, dossier, session management, PDF/Markdown/JSON export,
browser speech recognition, and optional ElevenLabs speech input/output. LiveKit is not included:
its current voice mode relies on a separate always-running worker, which this Netlify app does not
host. The Node server does not probe the LLM at startup; it reports provider configuration errors
when an interview turn is requested. Netlify AI Gateway supplies model API credentials on supported
credit-based plans; it requires at least one production deployment before it is activated.

## Deploy steps

1. Install dependencies in this folder with `npm install`.
2. In Netlify, connect this repository and set the base directory to `netlify-app`.
3. For Netlify AI Gateway, enable AI features for the team and choose a supported model via
   `LLM_MODEL`. Alternatively, add your own `LLM_API_KEY` (and, if needed, `LLM_BASE_URL`) as
   runtime environment variables.
4. Deploy. The Netlify site's server runtime must be enabled for this project.
