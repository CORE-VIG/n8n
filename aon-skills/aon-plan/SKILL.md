---
name: aon-plan
description: Use when the owner wants to add, check off, or review his to-do list, or asks for a daily briefing — keeps his plan in the "Aon plan" n8n data table (create it once if missing) and reports due, doing, and overdue in plain words.
---

# The plan board

His tasks live in one n8n Data Table named exactly `Aon plan`, columns:
`title` (string), `status` (string: `todo` | `doing` | `done` | `dropped`),
`due` (string, ISO date or empty), `note` (string), `createdAt` (string,
ISO timestamp). It is a normal data table, so Guard classes every change to
it `datatable.write`, tier 1 — an agent may create tasks on its own, up to
its ceiling.

The only data-table tools this instance has are: `search_data_tables`,
`create_data_table`, `rename_data_table`, `add_data_table_column`,
`delete_data_table_column`, `rename_data_table_column`,
`add_data_table_rows`, `get_data_table_rows`. There is no tool that updates
or deletes a row in place — only insert and read. The plan board works
around that: it is append-only, and the newest row for a given title is
that task's current truth.

## Set up the table (once)

1. `search_data_tables` for `Aon plan`. If it exists, use its id.
2. If it does not exist, `create_data_table` with that exact name and the
   five columns above, all `string` type (dates and timestamps as ISO
   text, not the date type, so an empty `due` is allowed).

## Add a task

`add_data_table_rows` with one row: `title`, `status: "todo"`, `due` (or
empty), `note` (or empty), `createdAt` set to now, ISO.

## Move a task (change its status)

There is no update tool, so "moving" a task means adding a new row with
the same `title` and the new `status` (and the same or a refreshed `due`
and `note`). When you read the board, take the newest row per title as
its real status — never treat an older row as still current.

## Read the board

`get_data_table_rows` sorted `createdAt:desc`. Reduce to the latest row
per `title` before you do anything else with the result — the raw rows
are a log, not the board.

## The daily briefing

From the reduced board, in plain words, no bullet dump unless he asks:
tasks **due today** (by `due`), tasks **doing** right now, and anything
**overdue** (`due` before today and not `done` or `dropped`). Say counts
first, then name the ones that matter — overdue first, then due today.
If the board is empty or the table does not exist yet, say that plainly
rather than inventing a summary.
