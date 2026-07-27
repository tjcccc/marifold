---
name: translate
description: Translate text into a selected language.
mode: chat
variables:
  - name: source_text
    required: true
  - name: target_language
    required: true
---

Translate the following text into {{target_language}}.

Return only the translation. Preserve the source formatting and meaning.

{{source_text}}
