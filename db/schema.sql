-- The data model behind docs/spec.md ("How it works", "Audit trail", "Testers").
-- The fixed rules, AI guidelines and original pages live in files. The database
-- holds each editor's copy of the batch and the audit trail: every check result,
-- AI proposal and editor decision. The three audit tables are only ever added to.
-- Ids are bigint identity, except pages, which keep the id from their file.
-- Apply once to an empty database:
--   docker exec -i content-compliance-postgres psql -U compliance -d compliance -v ON_ERROR_STOP=1 < db/schema.sql

-- The person reviewing content. In the public demo, each tester is an editor.
CREATE TABLE editors (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id text NOT NULL UNIQUE, -- how the server recognises this person
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The imported batch as it arrived, loaded from content/pages/.
CREATE TABLE pages (
    id        integer PRIMARY KEY, -- the id in the page's file
    path      text NOT NULL UNIQUE,
    title     text NOT NULL,
    page_type text NOT NULL,
    audience  text NOT NULL CHECK (audience IN ('patients', 'healthcare professionals')),
    medicine  text,
    certified date NOT NULL,
    body      text NOT NULL
);

-- One editor's own copy of the batch. Reset closes the copy and opens a new one,
-- so the old copy's audit trail is kept.
CREATE TABLE copies (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    editor_id  bigint NOT NULL REFERENCES editors (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    reset_at   timestamptz
);
CREATE UNIQUE INDEX copies_one_open_per_editor ON copies (editor_id) WHERE reset_at IS NULL;

-- Each page in a copy, as it stands now. The statuses are the README glossary's.
CREATE TABLE copy_pages (
    copy_id    bigint NOT NULL REFERENCES copies (id),
    page_id    integer NOT NULL REFERENCES pages (id),
    body       text NOT NULL, -- the last saved text
    status     text NOT NULL DEFAULT 'candidate' CHECK (status IN (
                   'candidate', 'ready_for_review', 'needs_manual_fix',
                   'recommend_retire', 'recommend_redirect',
                   'approved_migrate', 'approved_retire', 'approved_redirect')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (copy_id, page_id)
);

-- Audit trail: everything the AI proposes. A fix or rewrite reaches the editor
-- only if every fixed rule passed it (see check_results).
CREATE TABLE proposals (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_id        bigint NOT NULL,
    page_id        integer NOT NULL,
    kind           text NOT NULL CHECK (kind IN ('outcome', 'fix', 'cannot_fix', 'rewrite')),
    outcome        text CHECK (outcome IN ('migrate', 'retire', 'redirect')),
    target_page_id integer REFERENCES pages (id), -- the redirect target
    rule_id        text, -- the failed rule a fix is for
    attempt        smallint CHECK (attempt BETWEEN 1 AND 2),
    original_text  text,
    proposed_text  text,
    reason         text,
    model          text, -- which AI model; null for a scripted example
    scripted       boolean NOT NULL DEFAULT false, -- a labelled example response
    proposed_at    timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (copy_id, page_id) REFERENCES copy_pages (copy_id, page_id),
    CHECK ((kind = 'outcome') = (outcome IS NOT NULL)),
    CHECK (kind <> 'outcome' OR reason IS NOT NULL),
    CHECK ((outcome IS NOT DISTINCT FROM 'redirect') = (target_page_id IS NOT NULL)),
    CHECK ((kind IN ('fix', 'cannot_fix')) = (rule_id IS NOT NULL)),
    CHECK ((kind = 'fix') = (attempt IS NOT NULL)),
    CHECK (kind NOT IN ('fix', 'rewrite') OR (original_text IS NOT NULL AND proposed_text IS NOT NULL)),
    CHECK (kind <> 'cannot_fix' OR (reason IS NOT NULL AND proposed_text IS NULL))
);
CREATE INDEX proposals_copy_page ON proposals (copy_id, page_id);

-- Audit trail: everything the editor decides, with who, when and why (the note).
CREATE TABLE decisions (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_id        bigint NOT NULL,
    page_id        integer NOT NULL,
    editor_id      bigint NOT NULL REFERENCES editors (id),
    proposal_id    bigint REFERENCES proposals (id), -- the AI change being decided
    action         text NOT NULL CHECK (action IN (
                       'accept', 'edit', 'reject', 'undo', -- on an AI change
                       'save',                             -- the page text, saved
                       'migrate', 'retire', 'redirect', 'reopen')), -- the page's outcome
    target_page_id integer REFERENCES pages (id), -- the confirmed redirect target
    original_text  text,
    final_text     text,
    note           text,
    decided_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (copy_id, page_id) REFERENCES copy_pages (copy_id, page_id),
    CHECK ((action IN ('accept', 'edit', 'reject', 'undo')) = (proposal_id IS NOT NULL)),
    CHECK (action NOT IN ('edit', 'save') OR (original_text IS NOT NULL AND final_text IS NOT NULL)),
    CHECK ((action = 'redirect') = (target_page_id IS NOT NULL))
);
CREATE INDEX decisions_copy_page ON decisions (copy_id, page_id);

-- Audit trail: every check result. A fixed rule can fail a page. A triage check
-- only informs the AI's recommendation. Checks run on the page at "Prepare for
-- review", on each AI proposal, and on each edit or save by the editor.
CREATE TABLE check_results (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    copy_id        bigint NOT NULL,
    page_id        integer NOT NULL,
    ran_on         text NOT NULL CHECK (ran_on IN ('page', 'proposal', 'decision')),
    proposal_id    bigint REFERENCES proposals (id),
    decision_id    bigint REFERENCES decisions (id),
    check_kind     text NOT NULL CHECK (check_kind IN ('fixed_rule', 'triage_check')),
    check_id       text NOT NULL, -- the rule's or check's id in the config
    config_version text NOT NULL, -- which version of the rules config ran
    passed         boolean NOT NULL,
    reason         text, -- why it failed, or what the triage check found
    checked_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (copy_id, page_id) REFERENCES copy_pages (copy_id, page_id),
    CHECK ((ran_on = 'proposal') = (proposal_id IS NOT NULL)),
    CHECK ((ran_on = 'decision') = (decision_id IS NOT NULL))
);
CREATE INDEX check_results_copy_page ON check_results (copy_id, page_id);
