---
name: echo
description: Repeat the given text back unchanged — a tiny skill for testing the install/run loop.
mode: chat
variables:
  - name: text
    description: The text to echo back.
    required: true
---

Repeat the following text back exactly, with no extra words, quotes, or commentary:

{{text}}
