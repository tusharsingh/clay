# Sub-task Sprint Orchestration: $ARGUMENTS

You are orchestrating work on JIRA parent issue **$ARGUMENTS** and its
sub-tasks. The user wants a phased plan they can execute one phase at
a time, with Clay sessions spawned per sub-task in each phase.

This skill is invoked **once per phase**. On first run it builds the
plan and starts Phase 1. On every subsequent invocation it inspects
JIRA for current status, decides which phase to run next, and spawns
the Clay sessions for it.

---

## Step 1: Discover Atlassian Site

Call `mcp__atlassian__getAccessibleAtlassianResources` to get the cloud
ID. Cache it for the rest of this skill. Fail loudly if this errors.

## Step 2: Fetch Parent Issue

Call `mcp__atlassian__getJiraIssue` with the cloud ID, issue key
`$ARGUMENTS`, and `responseContentFormat: "markdown"`. Capture the
parent's summary, type, and current status.

If the parent is not found, stop and ask the user to verify the key.

## Step 3: Fetch Sub-tasks

Call `mcp__atlassian__searchJiraIssuesUsingJql` with a JQL like:

```
parent = "$ARGUMENTS" ORDER BY rank ASC
```

For each result, capture: key, summary, current status, assignee (if
any), and the issue's links (call
`mcp__atlassian__getJiraIssue` per sub-task if the JQL response
doesn't include link types — needed for dependency detection in
Step 5).

If the JQL returns zero sub-tasks, stop and tell the user: parent
issue has no sub-tasks, this skill has nothing to orchestrate.

**Include sub-tasks regardless of status** (To Do, In Progress, Done,
Blocked, etc.) — the user explicitly wants visibility into all of
them, not just the open ones. Status drives phase advancement; you
will skip already-Done sub-tasks when spawning sessions.

## Step 4: Display the Sub-task Inventory

Print a compact table of every sub-task so the user can see what
they're starting from:

```
## Sub-tasks of $ARGUMENTS — <parent summary>

| Key      | Status        | Summary                          |
|----------|---------------|----------------------------------|
| GP-222   | Done          | Setup auth scaffolding           |
| GP-223   | In Progress   | Add database schema              |
| GP-224   | To Do         | Create test fixtures             |
| ...      | ...           | ...                              |
```

## Step 5: Identify Dependencies

For each sub-task, derive its blockers from:

1. **JIRA issue links** — the most authoritative source. Look for
   link types "Blocks", "Is Blocked By", "Depends On", "Has To Be
   Done After". Treat "Is Blocked By GP-X" as "depends on GP-X".
2. **Description and acceptance-criteria text** — natural-language
   references like "After GP-X is done…" or "Requires GP-Y".
3. **Type-driven defaults** — UI sub-tasks tend to depend on API
   sub-tasks of the same epic; integration tests tend to depend on
   all feature work. Apply this only when no explicit link exists
   and call it out as inferred.

Be explicit when a dependency is inferred vs. declared in JIRA.

## Step 6: Build Phases

Topologically sort sub-tasks into phases:

- **Phase 1**: sub-tasks with no dependencies (or whose dependencies
  are already Done).
- **Phase N>1**: sub-tasks whose dependencies are all satisfied by
  earlier phases or by sub-tasks already Done in JIRA.

Within a phase, sub-tasks run in parallel (the user fans them out
into separate Clay sessions). So a phase should be the *maximal* set
of sub-tasks that have no unsatisfied dependencies — don't artificially
split them.

If a cycle is detected in the dependency graph, stop and report it.
Cycles need human intervention.

## Step 7: Render the Dependency Tree

Show the phased plan as a markdown tree, marking each item with its
JIRA status:

```
$ARGUMENTS — <parent summary>
│
├── Phase 1 — independent setup
│   ├── ✓ GP-222 — Setup auth scaffolding         [Done]
│   ├── ◐ GP-223 — Add database schema            [In Progress]
│   └── ○ GP-224 — Create test fixtures           [To Do]
│
├── Phase 2 — depends on Phase 1
│   ├── ○ GP-225 — Auth UI                        [To Do]  ← blocked by GP-222
│   └── ○ GP-226 — Auth API                       [To Do]  ← blocked by GP-222, GP-223
│
└── Phase 3 — depends on Phase 2
    └── ○ GP-227 — Integration tests              [To Do]  ← blocked by GP-225, GP-226
```

Legend: `✓` Done, `◐` In Progress, `○` To Do, `⚠` Blocked.

## Step 8: Decide Which Phase to Run

Walk the phases in order and find the **first phase that has at
least one sub-task not yet Done**. That's the target phase.

- If every phase is fully Done, congratulate the user — the parent
  is complete. Stop without spawning anything.
- If a target phase exists, tell the user which phase it is, list
  the sub-tasks in that phase, and **wait for explicit approval
  before spawning Clay sessions**.

The user might say "skip GP-225 for now" or "only spawn GP-224 from
this phase" — respect their override.

## Step 9: Spawn Clay Sessions for the Target Phase

For each sub-task in the approved phase that is **not already Done**:

Call `spawn_session` (from `clay-sessions` MCP — exposed as
`mcp__clay-tools__clay-sessions__spawn_session` via the bridge in TUI
sessions). One call per sub-task, in **parallel** in a single agent
turn.

Arguments per call:

- `title`: just the JIRA key (e.g. `"GP-225"`). The `/jira` slash
  command running inside the spawned session will refine it to
  `"GP-225 — <summary>"` once it fetches the issue.
- `initial_prompt`: `"/jira GP-225"` (slash command, including the
  key as its arg).
- `mode`: omit (defaults to `"tui"` for subscription billing).
- `permission_mode`: omit (defaults to `"plan"` so each session
  produces a plan before touching code).
- `effort`: omit (defaults to `"high"`).

Sub-tasks that are already **In Progress** should also be spawned —
the user explicitly said they want to continue them. The `/jira`
skill inside that session will pick up where the prior work left off.

Sub-tasks already **Done** should NOT be spawned — skip them and note
why in the summary.

## Step 10: Summarise and Hand Off

In a short final message, tell the user:

- Which phase you started (e.g. "Phase 2 of 3").
- Which sub-tasks were spawned, with their Clay session localIds
  (from the `spawn_session` tracking lines).
- Which sub-tasks were skipped and why ("GP-222 already Done").
- How to advance: "Re-run `/sprint $ARGUMENTS` once you're done with
  this phase and I'll detect completion in JIRA and launch the next
  one."

Do NOT switch the user's view to any of the spawned sessions — they
stay in the dispatcher session (this one) so they can come back here
to advance.

---

## Rules

- **JIRA is the source of truth for phase advancement** — don't rely
  on Clay's done flag for orchestration decisions. Always re-fetch
  sub-task status from JIRA at Step 3 on every invocation.
- **One phase per invocation** — never spawn sub-tasks from a later
  phase before the current phase is Done in JIRA. The user explicitly
  wants phased execution, not "all sub-tasks at once".
- **Approval gate before each phase launch** — Step 8's "wait for
  approval" is non-negotiable. The user may want to override
  ordering, skip a sub-task, or pause.
- **Parallel spawn within a phase** — call `spawn_session` once per
  sub-task in a single turn so the sessions appear together in the
  sidebar instead of trickling in.
- **Skip Done sub-tasks** — never spawn a session for a sub-task that
  JIRA already shows as Done. The user wants resumption, not
  duplication.
- **Inferred dependencies are flagged** — when you derive a
  dependency from description text or type heuristics rather than a
  JIRA link, mark it `(inferred)` in the tree so the user can
  correct you.
- **Native tools over bash** — when reading source files to enrich
  dependency analysis, use Read / Grep / Glob, not `bash` running
  `cat` / `grep` / `find`.
- **Subagents for cross-cutting analysis** — if dependencies aren't
  obvious from JIRA alone and you need to inspect code to figure out
  ordering (e.g. "does the API exist for GP-225's UI work?"),
  dispatch parallel Explore subagents rather than doing it
  sequentially in the main turn.
