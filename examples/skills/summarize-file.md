---
name: summarize-file
description: Read a file in the working directory and summarize it.
variables:
  - name: path
    description: Path to the file, relative to the working directory.
    required: true
---

Read the file {{path}} and write a concise summary of what it contains and what it is for.
Use the read_file tool; do not guess at contents you have not read.
