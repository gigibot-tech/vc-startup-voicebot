# Startup Voice Intake Agent (HTGF)

Voice-first founder intake with step-evaluable session artifacts and HTGF styling.

```bash
uv sync
# .env: ELEVENLABS_API_KEY=…  (+ optional DEEPGRAM_API_KEY)
# Needs a live LLM (Ollama granite4.2:8b default) — no heuristic fallback.
uv run startup-voice
# open http://127.0.0.1:8140/
```

See [features/startup-voice-intake.md](features/startup-voice-intake.md).
