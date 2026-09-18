# ADR-0002: P05_Remote_Agent is the project source of truth

Status: Accepted  
Date: 2026-09-18

## Decision

`YanfengSong/P05_Remote_Agent` is the canonical repository for all controlled project assets: source code, tests, configuration examples, architecture documents, research notes and ADRs.

Generated build output, dependency folders, logs and secrets remain local and are excluded by `.gitignore`.

## Consequence

Future development work must be synchronized to this repository. Design decisions that materially affect architecture should be recorded under `docs/adr/` rather than existing only in chat history.
