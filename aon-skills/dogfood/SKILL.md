---
name: dogfood
description: Use when the owner asks you to test, dogfood, or QA a web app before he trusts it — picks the five riskiest flows, exercises each with web_read/web_act and Hands, and reports exactly what broke.
---

# Dogfood a web app

Exploratory QA through your own tools: `web_read` (open a page, read its
text and links), `web_act` (navigate, click, type, wait, snapshot,
screenshot, one lease at a time), and Hands (`hands_run`, `hands_write_file`)
when a check needs a script rather than a click. Never enter a real
password, card number, or any credential that is actually his; use
obviously fake values ("test@example.com", "0000") and say so in the report.

## 1. Pick the five riskiest flows

Before touching the browser, list what would hurt most if it were broken:
sign-up or login, the primary action the app exists for (checkout, submit,
save, publish), anything that sends money or mail, the first-run empty
state, and one edge case (a very long input, a double-submit, a back-button
after a form). Pick five; say which five and why in one line each.

## 2. Exercise each flow

For each flow:
1. `web_read` the starting page; note its title and the links you will
   follow.
2. `web_act` through the flow step by step: navigate, then one click or
   type per call, with a snapshot or screenshot after anything that should
   have changed the page.
3. Try it once straight, then once with a wrong input (empty field, bad
   format, a second submit) — validation bugs live there.
4. If a step needs a computed check (does a total match, is a file really
   there), use `hands_run` rather than eyeballing it.

## 3. Record what broke

The moment something is wrong, write it down before moving on — memory of
"which click" fades fast:
- the exact step (which flow, which action, what you typed or clicked);
- what you expected;
- what happened instead;
- the page's own error text, if any, verbatim.

Do not fix anything. Dogfooding finds problems; it does not patch them.

## 4. Report

A numbered list, worst first:
1. **Flow** — one line naming it.
   **Step** — the exact action that broke it.
   **Expected** vs **actual** — one line each.

Close with what you tested and what you did not (time, access, or a flow
that needed a real account you would not fake). If all five flows held,
say so plainly — a clean report is still a report.
