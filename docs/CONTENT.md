# Sample content

## The setting
Pages from a fictional pharma website that is moving to a new platform. Pages are mid-migration, so they carry the kind of errors a move creates. Everything is invented. The medicines are called "Example medicine A", "Example medicine B" and "Example medicine C", so they can't be mistaken for real products. No company is named.

## Why this sector
Technical enough to need fixed rules, not so technical that it is full of jargon.

## Sources
The rules and guidelines are based on public standards, so the demo reflects what a real UK health or pharma organisation would use.
- [NHS digital service manual: content guide](https://service-manual.nhs.uk/content): how to write health content, health literacy, and the standard for creating health content. Open Government Licence v3.0.
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), level AA: accessibility. W3C document licence.
- [ABPI Code of Practice 2024](https://www.pmcpa.org.uk/the-code/): the UK pharma industry's code on claims and information for the public. Rules below cite its clauses in our own words. They do not quote it.

The NHS guide warns that readability tools cannot tell you whether content is usable. That is one reason an editor reviews every page.

## Fixed rules
Pass or fail. A failure must be fixed before a page can migrate. Rules about wording and reading age skip protected wording, which is approved as it stands. For example, the side-effect reporting statement is never checked for "safety".

**Regulated content** (ABPI Code)
- Pages for patients taking a medicine include the side-effect reporting statement that points to the MHRA Yellow Card scheme (clause 26.4).
- Every page states its intended audience: patients or healthcare professionals (clause 26.2).
- "Safe" and "safety" are never used without qualification, and no page says a medicine has no side effects (clause 6.4).
- "Best", "strongest" and "unique" only when substantiated as a simple fact (clause 14.4).
- No words from our claims list without substantiation on the page, for example "cures", "clinically proven" or "proven to help". The list is ours, based on clauses 6.2 (claims must be substantiated) and 26.2 (no unfounded hopes).
- Protected wording, such as dosage warnings, is unchanged.
- The page was certified in the last two years (clause 8).

**Writing for patients** (NHS content guide)
- Reading age of 11 or under. The NHS aims for 9 to 11.
- "Medicine", not "drug" or "medication". People "get" or "have" side effects, not "develop" or "experience" them.

**Structure and accessibility** (WCAG 2.2 AA and NHS content guide)
- Every informative image has alt text (WCAG 1.1.1).
- One main heading. Headings in sentence case and in order, with no skipped levels (WCAG 1.3.1).
- Link text makes sense on its own: no "click here" (WCAG 2.4.4).
- Links to PDFs end with "(PDF only, [file size])".
- Links work.

## Triage checks
Machine checks whose results inform the AI's recommendation (migrate, retire or redirect). They never fail a page.
- **Exact duplicate:** the page's text is identical to another page in the batch. The AI recommends which one to keep and recommends redirecting the other.
- **Redirect target:** when the AI recommends a redirect, the target page exists.

## AI guidelines
For content uplift: bringing each page up to date and in line with the standards. These guide the AI's suggestions and never fail a page.
- Plain English, with short, common words: "have" rather than "experience" (NHS).
- Sentences of up to 20 words where possible (NHS).
- The plain term first, then the medical term, for example "piles (haemorrhoids)" (NHS).
- Abbreviations spelled out on first use, unless well known, like NHS or GP (NHS).
- Active voice. Speak to the reader as "you" and avoid "should" (NHS).
- A neutral, factual, calm and reassuring voice: "talk to your doctor about…" (NHS).
- The key point first. Short paragraphs, subheadings, and bulleted lists of up to 6 items (NHS).
- No bold for emphasis, no italics (NHS).
- Factual and balanced about medicines. Nothing that reads as advertising a prescription medicine, raises unfounded hopes, or encourages people to ask for a specific medicine (ABPI clauses 26.1 and 26.2).
- Comparisons say what they compare against: "better than what?" (ABPI clause 6.1).
- Headings and alt text that describe the content, not just exist (WCAG 2.4.6 and 1.1.1).
- Written for the page's audience: plain English for patients, clinical terms allowed on pages for healthcare professionals.

## Demo cases
Ten pages, in `content/pages/`. Each one shows a route through the workflow in `docs/spec.md`. `content/site-files.yml` lists the files that exist on the fictional site, so the "links work" rule has something to check against. The demo checks certification as at 1 November 2026 (`config/rules.yml`), so these cases stay true as time passes.

Pages 1 and 2 show the rules catching an AI mistake. A good AI rarely makes these mistakes, so each page uses one scripted AI response, labelled in the panel as an example. The rules check it live. Everything else comes from the AI.

| # | Page | Outcome and status | What it shows |
|---|---|---|---|
| 1 | Patient information, Example medicine A | Migrate. Ready for review. | A scripted rewrite, labelled as an example, changes the dosage warning. The rules drop it before the editor sees it. The AI's own rewrites are shown. |
| 2 | Product page, Example medicine B | Migrate. Ready for review. | Says "clinically proven", from the claims list. A scripted first fix, labelled as an example, uses "proven to help", which is also on the list. The rules fail it. The AI's own second fix passes. |
| 3 | Patient leaflet page | Migrate. Needs manual fix. | The link to the leaflet PDF is broken. The AI cannot tell which leaflet is current and says so. The editor fixes the link. |
| 4 | Patient information, Example medicine C | Migrate. Ready for review. | The side-effect reporting statement is missing. The AI adds it. |
| 5 | Example medicine A, for healthcare professionals | Migrate. Ready for review. | Rules depend on the audience: the patient writing rules do not apply. The AI writes for a clinical audience, so it suggests little. |
| 6 | Support page | Migrate. Ready for review. | Fixes: an image without alt text, and "drug" instead of "medicine". Content uplift: long paragraphs, passive voice and "should". The editor accepts some suggestions and rejects others. |
| 7 | Condition guide | Migrate. Ready for review. | Passes every rule and the AI has nothing to suggest. The checks raise no false alarms. |
| 8 | Condition guide, older version | Redirect to page 7. Recommend: redirect. | Last certified more than two years ago, and page 7 covers the same ground. No fixes or rewrites are spent on it. |
| 9 | Support page, copy | Redirect to page 6. Recommend: redirect. | The duplicate check finds it identical to page 6. The AI recommends keeping page 6. Neither page carries a duplicate failure. |
| 10 | News item about a past event | Retire. Recommend: retire. | Out of date. It also fails the alt-text rule, but no fix is attempted, because the outcome is decided first. |
