# Content compliance MCP App

An example MCP App: a focused panel inside an AI assistant (such as Claude) where a non-technical editor reviews content before it goes live. Fixed rules decide what must be right. AI suggests fixes. A person decides.

Tagline: **AI proposes, people decide.**

## Principles
- Rule failures (must fix) are always shown apart from the AI's suggestions (the editor's call).
- Every suggestion is a diff with Accept, Edit and Reject. Nothing is published without a click.
- Every decision is written to an audit trail: who, what, when and why.
- Rules and the style guide live in config, so another organisation can swap in its own.
- Only claim what is built and true.

## Content
- All sample content is invented: pages from a fictional pharma website that is moving to a new platform. See `docs/CONTENT.md`.
- No real clients, products, people or organisations in the repo. No real medicine names.
- Medicines are called "Example medicine A", "Example medicine B" and "Example medicine C". Don't invent names that could sound like real products. Don't name a company or agency.
- Exception: public standards and style guides (for example WCAG or the NHS content style guide) may be cited as sources for rules and guidelines.

## Writing
- UK English.
- Write for buyers and editors, not developers. Plain words, short sentences.
- Use the terms in the README glossary. Don't invent new ones without agreeing them first.
- In public files, say "AI", not "Claude". The audience may use other AI assistants. Name Claude only where it is the platform, for example "an AI assistant such as Claude".

## Files
- Config and content lists (rules, guidelines, file lists and so on) are YAML (`.yml`).

## Docs
- `docs/` is a clean explanation of where the project stands now. It is not a build diary.
- Don't record progress, session activity or what changed in `docs/`. Rewrite a page so it reads as current fact.
- Track progress, if needed, in `private/PROGRESS.md`.

## Public repo rules
- This repo is public. Never commit secrets, keys, client names or details, pitch or marketing plans.
- Private notes go in `private/`, which git ignores.

## Further reading
- `docs/spec.md`: what the app does.
- `docs/CONTENT.md`: the sample content, fixed rules, AI guidelines and demo cases.
- `private/case-studies.md` (git-ignored, local only): published examples of the real-world problem.
- `db/schema.sql`: the database tables.

## Reference code
- For code design decisions, follow the official MCP Apps examples: [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps), `examples/`, at commit `cf599cc` (29 October 2026).
- If `private/reference/ext-apps/` exists locally, it is a shallow clone of that commit. Read it there rather than online.
- Use it as a reference only. Its code is licensed Apache-2.0, some still MIT. Don't copy code into this repo without keeping its licence notice.
- Its own `CLAUDE.md` and `AGENTS.md` are for people working on that repo. They don't apply here.

## Running locally
- Postgres: copy `.env.example` to `.env` and set a password, then run `docker compose up -d --wait`. It listens on `127.0.0.1:5433`.
- Code: run `npm install`, then `npm test` for the rule tests and `npm run typecheck` to check types. Node runs the TypeScript directly.
- On a new database, apply the schema once: `docker exec -i content-compliance-postgres psql -U compliance -d compliance -v ON_ERROR_STOP=1 < db/schema.sql`.

## Handoff
If `private/handoff.md` exists locally, read it first. It is git-ignored and must never be committed or quoted in public files.

## Commits

Every commit message follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>
```

`feat` adds a feature and `fix` fixes a bug. Other types such as `build`, `chore`, `ci`, `docs`, `refactor`, `perf`, `style` and `test` are allowed. Mark a breaking change with `!` before the colon or a `BREAKING CHANGE:` footer.
