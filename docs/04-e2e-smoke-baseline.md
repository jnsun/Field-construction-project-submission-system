# D04: Existing business smoke baseline and E2E skeleton

## Baseline and approach

The application is a static HTML/CSS/JavaScript site using Supabase directly. It has no `package.json`, test runner, backend service, or maintained browser-test configuration. Existing remote checks are Node scripts in `tests/e2e/` that authenticate against the explicitly configured test project. D04 therefore adds a zero-dependency Node orchestrator instead of introducing a second framework.

`tests/e2e/d04-smoke.js` has two layers:

1. Static entry-point checks for the T25 main-path surfaces, safe to run without credentials.
2. Existing authenticated API regression scripts only when `SAFETY_ENV=test` and all D02 test variables are present. It never falls back to another environment.

## Run and data lifecycle

```powershell
$env:SAFETY_ENV = 'test'
& '<NODE_PATH>' tests/e2e/d04-smoke.js
```

Before a live run, create only D02-marked fixtures through `sql/test-environment-v1.sql`. Existing API scripts create their own narrowly scoped records and clean them on success; fixture cleanup remains `tools/clear-test-fixtures.sql`. Do not use a production or shared employee account.

## Coverage baseline

| D04 case | D01 requirement | Current status | Evidence / follow-up |
| --- | --- | --- | --- |
| D04-S01~S08 | T25-AC01, T25-AC02, T25-AC07 | Static entry-point coverage | `d04-smoke.js` verifies page/module entry points; full browser path needs isolated accounts and state fixtures. |
| D04-S09~S10 | T25-AC06 | Static entry-point coverage | Visitor and temporary-access surfaces exist; live authorization remains pending. |
| D04-S11 | T25-AC05 | Static entry-point coverage | Pause/resume/close migration entry exists; state-transition E2E remains pending. |
| D04-S12 | T25-AC04 | Static entry-point coverage | High-risk rule migration entry exists; four-role scenario remains pending. |
| D04-LIVE | T25-AC01~AC07 | Failed baseline on 2026-09-03 | The explicit local test gate passed. `verify-dept-fix.js`, `verify-people.js`, and `verify-stats.js` each failed; see recorded failures below. |

## 2026-09-03 live baseline result

- `D04-S01` through `D04-S12`: passed (12 static entry-point checks).
- `D04-LIVE-verify-dept-fix.js` / `T25-AC03` / P1: entity project-department creation response was not parsed as the expected list, so the scenario could not obtain its created department id.
- `D04-LIVE-verify-people.js` / `T25-AC01` / P1: no `profiles.employee_id` bindings were observed by the test account; direct `training_employees` read was denied to `authenticated`, and the required company root department was not found.
- `D04-LIVE-verify-stats.js` / `T25-AC07` / P1: `stats_overview(p_dept, p_from, p_to)` was absent from the PostgREST schema cache; no valid organization scope was available for the remaining authority checks.

These are failures to be fixed in their dedicated T25/T19 follow-up work, not skipped checks or passing evidence.

The D02 fixture rerun on the same date verified three database-level anonymous account bindings. The unchanged `verify-people.js` failure is therefore an authenticated API visibility/authorization or test-contract issue, not missing fixture bindings.

## Failure recording rule

Any failing live result must retain the D04 case id, mapped T25 acceptance item, expected/actual summary, severity and sanitized command output. Store screenshots or logs only under ignored `test-results/d04/`; never include personal data, passwords, access tokens or full identity numbers.

## Known baseline limits

- Four anonymous project-state fixtures, two private buckets and three account bindings exist in the isolated test project. Full cross-project, high-risk, pause/reopen, temporary-access and visitor flows are still not claimed as passed until their dedicated API/browser scenarios run.
- Browser UI execution needs an explicit local CDP setup; the legacy helpers use a fixed local debugging port and are not a maintained Playwright project.
- D04 intentionally does not repair functional defects discovered by the smoke suite; each failure is a tracked T25 item for the subsequent dedicated task.
