#!/usr/bin/env bash
# Regenerates tests/fixtures/speech_de_two_turns.wav with macOS `say` (German voice "Anna").
# Layout (seconds): 0.6 silence | utterance 1 = two sentences with a 0.4 s thinking pause |
# 2.5 s silence (turn must end here) | utterance 2 | 3 s silence.
set -euo pipefail
cd "$(dirname "$0")"
say -v Anna -o /tmp/speech_tmp.aiff "[[slnc 600]] Wir sind zwei Gründer und bauen eine App für Studierende. [[slnc 400]] Unser Produkt hilft beim Sprachenlernen. [[slnc 2500]] Wir haben schon dreißig Nutzer. [[slnc 3000]]"
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/speech_tmp.aiff speech_de_two_turns.wav
rm -f /tmp/speech_tmp.aiff
