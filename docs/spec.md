# Specification

## What it is
A remote MCP server people add to an AI assistant that supports MCP Apps, such as Claude, as a connector. The server provides tools and serves one interactive panel (an MCP App) that the assistant shows inside the conversation.

The assistant's own AI does the AI work, through the server's tools. The server holds the rules, the data and the panel. It needs no AI service of its own.

The app helps an editor move a batch of pages to a new site. Each page is migrated, retired or redirected. Automation does the repetitive work. A person decides every page.

## Two lists, both in config
- **Fixed rules.** Pass or fail checks a machine can run. For example: required wording, banned claims, preferred words, reading age, alt text, working links and certification dates. The rules check every page, every change the AI proposes and every edit the editor makes.
- **AI guidelines.** What the migration is trying to achieve and how to write. For example: plain English, clear structure and a calm, factual voice. The AI follows them when it proposes changes. They never fail a page.

Another organisation can swap in its own lists. The fixed rules are in `config/rules.yml`. Each rule names a check and its settings, such as a word list or the highest reading age allowed, so they can be changed without changing code. The AI guidelines are in `config/guidelines.yml`, each with its source.

Two triage checks also run: one finds exact duplicates in the batch, and one confirms a redirect target exists. Their results inform the AI's recommendation. They never fail a page.

## How it works
1. The editor sees a list of imported pages, each with the status "Candidate".
2. The editor clicks "Prepare for review", which hands the request to the AI through the chat. The AI works through the server's tools, and the server checks everything it proposes. For each page:
   1. The rules check the page, and the duplicate check compares it with the rest of the batch.
   2. The AI recommends an outcome: migrate, retire or redirect, with a reason. It sees the whole batch, so it can name another page as a redirect target and decide duplicates consistently. For a redirect, a check confirms the target page exists.
   3. If the page is to migrate and fails the rules, the AI proposes a fix for each failure. The rules check each fix, with up to two tries. If the AI cannot fix a failure, it says why.
   4. If the page is to migrate, the AI proposes content uplift: rewrites that bring the page up to date and in line with the guidelines. Any rewrite that fails the rules is dropped.
   5. The page gets a status: "Ready for review", "Needs manual fix", "Recommend: retire" or "Recommend: redirect". "Ready for review" means every rule passes once the AI's proposed fixes are accepted.
3. The editor opens every page, including pages with no issues, reviews the changes and saves.
4. The editor decides the outcome:
   - **Migrate:** only when every rule passes.
   - **Retire:** always possible, because nothing is published.
   - **Redirect:** after confirming the target.

   The status becomes "Approved: migrate", "Approved: retire" or "Approved: redirect". A page that still fails the rules stays in the list until it is fixed.

## The panel in the conversation
One panel does all the work. It opens once and stays open while the editor and the AI work through the batch.

### Opening it
- The editor asks the assistant to open the batch. The AI calls `open_batch`, the only tool that opens a panel. Every call to a tool with a panel adds a new copy of the panel to the conversation, so no other tool has one.
- The panel first appears as a small card in the conversation. Hosts show every panel this way at first.
- The card's button, "Open review", asks the host to show the panel full screen. In Claude Desktop, full screen is a pane beside the conversation, with the conversation and its message box alongside. The host decides. The panel tells the host at the start that it supports the card and full screen, shows the button only if the host offers full screen, and copes if the host says no.
- The panel can't go full screen by itself. Asked as soon as the panel loads, Claude Desktop keeps it in the conversation, so the editor clicks once.
- If the AI calls `open_batch` again, the older copies grey out, stop sending anything to the AI, and point to the newest one. The server numbers each copy from the database, so every device agrees which is newest.

### The review pane
- The pane has two views, each filling the pane: the list of pages, and a single page. The pane beside the conversation is narrow, so it is laid out as for a phone.
- The list view shows each page with its status and recommended outcome. Choosing a page opens the page view: Must fix, AI suggests, the page text, the recommended outcome and the page's audit trail. Its Back button returns to the list view.
- Details open in place, with no pop-ups, menus or floating windows.
- Its actions are "Prepare for review", "Check your own text" and "Reset".
- Controls stay inside the area the host marks as safe, so the message box never covers them.

### The card
When the pane is closed, the card shows progress, for example "6 of 10 pages decided", and one button, "Continue review".

### How the AI does its part
- "Prepare for review" hands the request to the AI through the chat. In Claude Desktop, the request appears in the message box, alongside anything the editor has typed, and goes when the editor sends it. The button works once, so the request is never sent twice.
- The AI works through tools that have no panel. The server checks every recommendation and proposal against the fixed rules, stores those that pass, and refuses anything out of order, such as a fix for a page the AI has recommended for retirement.
- To ask for a different wording, the editor writes in the message box beside the pane.

### How the panel stays up to date
- While the AI works, the panel reads progress from the server every second or two, so the list and the open page update as each step finishes.
- Everything is kept in the database, not in the panel or in the server's memory, so this works however many copies of the server are running.
- The panel fetches a page's full detail only when the editor opens it, so each response stays small.

### How the AI learns of the editor's decisions
- The editor's actions go straight from the panel to the server, through tools the AI can't see. The server re-runs the rules on any edit and records the decision in the audit trail.
- The panel also passes each decision to the AI as context, so the conversation can carry on from it. In Claude Desktop, the AI sees this context when it reads the panel, not automatically.

### How it looks
The panel uses the host's colours, fonts, corner sizes and borders, so it matches the assistant and follows its light or dark mode. Its background is transparent, so the conversation shows through, and it asks the host not to draw a border round it.

### Models for this design
The official MCP Apps examples ([modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps), `examples/`) each show part of it:
- `pdf-server`: one viewer, opened once and then changed by an AI tool with no panel. Tools only the viewer can use. A full-screen button.
- `system-monitor-server`: the panel reads the server on a timer, through a tool the AI can't see.
- `transcript-server`: the panel sends a message to the chat.
- `map-server`: the full-screen button only appears when the host offers full screen.

Claude's MCP Apps documentation covers the rest: the [design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines) (full screen, safe areas, no floating panels), [blending with Claude's theme](https://claude.com/docs/connectors/building/mcp-apps/transparent-theming), [superseding older copies](https://claude.com/docs/connectors/building/mcp-apps/instance-supersession) and [troubleshooting](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting) (keeping tool results small).

## The editor's view of a page
- **Must fix:** each rule failure with its reason, and the AI's proposed fix or its reason for not offering one.
- **AI suggests:** content uplift, shown as diffs.
- **Recommended outcome:** the AI's recommendation, with its reason, and the editor's decision.

Each proposed change has Accept, Edit and Reject, and an optional note. The editor can also edit the text by hand. To ask for a different wording, the editor says so in the chat. The rules re-run on every change. The AI never rewrites the editor's own edits. Each decision is stored on the server and passed to the AI, as described above.

A small secondary option lets the editor paste their own text. The rules check it, and nothing pasted is stored.

## Tools (proposed)
Only one tool opens the panel. The AI's tools have no panel of their own. The panel's tools are hidden from the AI.
- `open_batch`: opens the panel on the batch, and numbers this copy of the panel.
- `check_page` (AI and panel): runs the fixed rules on a page and returns failures with reasons. It also runs the duplicate check: whether the page's text is identical to another page in the batch.
- `recommend_outcome` (AI): takes the AI's migrate, retire or redirect recommendation and its reason, confirms a redirect target exists, and stores it.
- `propose_fixes` (AI): takes the AI's fixes, its reasons for any failure it can't fix, and its rewrites. It checks each change against the rules and stores it with its results; the editor sees only the changes that pass. Each failure gets two tries. Refuses changes to a page recommended for retire or redirect. Its description gives the AI the guidelines in `config/guidelines.yml`.
- `get_progress` (panel): returns each page's status and recommended outcome, and what the AI is working on.
- `get_page` (AI and panel): returns one page in full: text, rule results, the AI's changes that passed the rules, and its audit trail. The AI reads pages here before proposing changes.
- `record_decision` (panel): stores each Accept, Edit or Reject, each save and each page outcome, with an optional note.
- `reset` (panel): starts a fresh copy.

## Audit trail
Each entry records: page, item, decision, original text, final text, note, timestamp and who decided. Rule results, the AI's proposals and page outcomes are recorded too. In the public demo, "who" is the tester.

## Testers
Each tester gets their own copy of the content. Their edits are never visible to anyone else. A reset button restores the original by starting a fresh copy. The audit trail of the earlier copy is kept.

Two demo pages use a scripted AI response to show the rules catching a mistake, because a good AI rarely makes it. Each one is labelled in the panel as an example, and the rules check it live. Testers can also type a banned claim, such as "clinically proven", into any page and see the rules fail it. See `docs/CONTENT.md`, pages 1 and 2.

## Out of scope for the first version
Sign-in, real publishing, and connecting to a real content management system.

## Build and hosting (proposed)
- **Panel:** a React app, bundled into a single HTML file with Vite. The server sends this file to the assistant, which shows it in the conversation. The MCP Apps SDK's React hooks connect it to the host and apply the host's styles (`useApp`, `useHostStyles`).
- **Server:** built with the official MCP TypeScript SDK on Express, following the official MCP Apps examples.
- **AI:** the assistant's own AI. The server calls no AI service and holds no AI key.
- **Data:** each tester's copy, their decisions and the audit trail are kept in a Postgres database. The tables are in `db/schema.sql`. On a local computer it runs in a container (`compose.yaml`).
- **Hosting:** for now everything runs on one computer, and the assistant connects to the local server through `mcp-remote`. The host for the public demo is not chosen. The server is a standard Node app and the data is in Postgres, so another organisation can run both on its own cloud.
