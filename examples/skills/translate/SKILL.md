---
name: translate
description: Translate text into a target language.
mode: chat
variables:
  - name: language
    description: Target language (e.g. Japanese, French).
    required: false
    default: English
  - name: text
    description: The text to translate.
    required: true
---

Translate the following text into {{language}}. Reply with only the translation, no preamble.

{{text}}
