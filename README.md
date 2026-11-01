# Content compliance MCP App

An example of an MCP App: a focused panel inside an AI assistant (such as Claude) where an editor checks content before it goes live.

**AI proposes, people decide.**

- AI suggests fixes, shown as before-and-after changes.
- The editor accepts, edits or rejects each one.
- Every decision is recorded in an audit trail.

All sample content is invented. Status: in design. See `docs/` for the specification, sample content and background.

## Glossary
- **Editor:** the person reviewing content. They decide every page.
- **Fixed rules:** pass or fail checks a machine can run, such as required wording or alt text. They check every page and every change.
- **Must fix:** a fixed rule failure. It must be fixed before a page can migrate.
- **AI guidelines:** how the AI writes when it suggests changes. They never fail a page.
- **Content uplift:** the AI's suggested changes that bring a page up to date and in line with the guidelines. The editor accepts, edits or rejects each one.
- **Protected wording:** text that must stay exactly as approved, such as a dosage warning.
- **Triage:** deciding each page's outcome before any other work is done.
- **Triage checks:** machine checks that inform triage, such as finding exact duplicates. They never fail a page.
- **Outcome:** what happens to a page. **Migrate** moves it to the new site. **Retire** removes it. **Redirect** sends visitors to another page.
- **Prepare for review:** the button that runs the rules, triage, fixes and content uplift on a batch of pages.
- **Card:** the small view of the panel in the conversation. It shows progress and opens the review pane.
- **Review pane:** the panel shown full screen, beside the conversation. The editor reviews and decides every page here.
- **Statuses:** "Candidate" (imported), "Ready for review", "Needs manual fix", "Recommend: retire", "Recommend: redirect", and "Approved: migrate", "Approved: retire" or "Approved: redirect" once the editor decides. "Ready for review" means every rule passes once the AI's proposed fixes are accepted.
- **Audit trail:** the record of every rule result, AI suggestion and editor decision: who, what, when and why.
