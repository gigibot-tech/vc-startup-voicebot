"""Interview feature: the AI brain (LLM client, prompts, config, pipeline) + its routes and UI.

Everything that decides WHAT THE AGENT SAYS lives here:

    llm.py        the only module that talks to the language model (Ollama / OpenAI-compatible)
    prompts.py    every prompt text sent to it
    config.py     the user-editable part of those prompts (greeting, reply prompt, questions)
    pipeline.py   orchestrates one turn: extract -> score -> reply (+ finalize, tool updates)
    routes.py     HTTP endpoints that trigger the pipeline
    ui/           browser side: chat (sendText) and the prompt/question editor
"""
