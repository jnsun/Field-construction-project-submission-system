# D04: Existing business smoke baseline and E2E skeleton

## Baseline and approach

The application is a static HTML/CSS/JavaScript site using Supabase directly. It has no `package.json`, test runner, backend service, or maintained browser-test configuration. Existing remote checks are Node scripts in `tests/e2e/` that authenticate against the explicitly configured test project. D04 therefore adds a zero-dependency Node orchestrator instead of introducing a second framework.

`tests/e2e/d04-smoke.js` has two layers:

1. Static entry-point checks for the T25 main-path surfaces, safe to run without credentials.
2. Existing authenticated API regression scripts only when `SAFETY_ENV=test` and all D02 test variables are present. It never falls back to another environment.

## Test inventory (2026-09-05)

| Category | Current entry | Baseline status |
| --- | --- | --- |
| Lint | No package manager or lint configuration | Not implemented |
| Type check | No TypeScript configuration | Not implemented |
| Unit | Standalone Node and PowerShell verification scripts | No D04 unit-test runner; D04 uses static smoke checks |
| API / integration | `verify-dept-fix.js`, `verify-people.js`, `verify-stats.js` | Only runs in the isolated test environment after the explicit `SAFETY_ENV=test` gate |
| E2E | `d04-auth-home-smoke.js`; `d04-smoke.js`; legacy Chrome/CDP helpers | Minimal live homepage/authentication E2E is repeatable; full browser business E2E is intentionally not implemented in D04 |
| Build | Static HTML/CSS/JavaScript site | No build command is implemented |

## Run and data lifecycle

```powershell
$env:SAFETY_ENV = 'test'
& '<NODE_PATH>' tests/e2e/d04-smoke.js
& '<NODE_PATH>' tests/e2e/d04-auth-home-smoke.js
& '<NODE_PATH>' tests/e2e/run-d04-stats-with-fixture.js
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

## 2026-09-05 local baseline rerun

- Command: `$env:SAFETY_ENV = 'inspection'; node tests/e2e/d04-smoke.js`
- Result: PASS (process exit `0`), 12 static cases passed, 0 failed, 1 live API case correctly blocked by the explicit test-environment gate; elapsed 175 ms.
- No API/integration or browser E2E test was run. The required isolated-test variables were intentionally not supplied, so the runner could not and did not fall back to another environment.

## 2026-09-05 isolated API baseline

Preflight passed before the API runs: `SAFETY_ENV=test`, the Supabase project reference matched the local test database connection, and the database contained 18 `D02-TEST-20260903` fixture registrations. No production connection was used.

| Existing baseline | Result and elapsed | Failed interface / code | Classification |
| --- | --- | --- | --- |
| `verify-dept-fix.js` | FAIL, 3/7 passed, 3.781 s | `GET /rest/v1/profiles` and `GET /rest/v1/departments`: HTTP 403 / `42501` | Existing business baseline: the legacy direct-read RLS expectation does not match the current permission policy. |
| `verify-people.js` | FAIL, stopped after 2.567 s | `GET /rest/v1/profiles`, `GET /rest/v1/training_employees`, and `GET /rest/v1/departments`: HTTP 403 / `42501`; the company-root lookup therefore could not continue | Existing business baseline: authenticated API visibility/RLS or its test contract is not satisfied. The test environment and both test-account logins were available. |
| `verify-stats.js` | FAIL, 1/11 passed, 2.873 s | `POST /rest/v1/rpc/stats_overview`, `stats_alert_sync`, `stats_alert_inbox`, `stats_export_records`, and `stats_overdue_list`: HTTP 404 / `PGRST202`; `stats_set_settings`: HTTP 404 | Test infrastructure/schema baseline: the expected statistics RPCs are absent from this test project's PostgREST schema cache. No migration was applied in D04. |

The first `verify-dept-fix.js` attempt stopped after 5.352 s because its result formatter called `reduce` on an error object. The formatter was minimally corrected to emit the actual HTTP/business code, syntax-checked, and only that script was rerun. No business behavior changed.

## 2026-09-05 statistics RPC schema confirmation

- Isolation preflight passed again: the API and database project references matched, and 18 `D02-TEST-20260903` fixture registrations were present.
- `sql/statistics-module.sql` defines ten `stats_*` functions. Eight are API RPCs used by `verify-stats.js`: `stats_overview(p_dept, p_from, p_to)`, `stats_overdue_list(p_dept, p_limit)`, `stats_alert_sync()`, `stats_alert_inbox(p_unread_only)`, `stats_alert_ack(p_ids)`, `stats_export_records(p_plan, p_dept)`, `stats_set_cert_target(p_dept, p_count)`, and `stats_set_settings(p_completion_threshold, p_overdue_grace_days)`. Their parameter names match the test calls. `stats_can_access(p_dept)` and `stats_scope_depts(p_dept)` are internal helpers and are not called directly by the test.
- A read-only `pg_proc` check found zero `public.stats_%` functions in the isolated test database. Therefore `PGRST202` is caused by a missing test-database Schema baseline, not a stale PostgREST Schema Cache.
- No Schema Cache reload was requested because no statistics functions existed for PostgREST to discover. No business SQL was deployed and `verify-stats.js` was not rerun.

## 2026-09-05 statistics test-schema deployment and rerun

- Isolation preflight passed immediately before deployment: `SAFETY_ENV=test`, API/database project references matched, and 18 D02 fixture registrations were present.
- The unchanged `sql/statistics-module.sql` (SHA-256 `2860A356558FA5E327154A24ADD648ED8402CA667D847218EC22BC39C0E20531`) was executed in one transaction. Deployment passed in 10.134 s; its built-in check reported 4 tables, 10 functions, and the initial settings row.
- The database contains 10 `public.stats_*` functions after deployment. All eight API function names and parameter names match `verify-stats.js`; the other two functions are internal helpers.
- PostgREST recognized `stats_overview(p_dept, p_from, p_to)` immediately (HTTP 200), so no manual Schema Cache reload was needed.
- `verify-stats.js` was run exactly once after deployment: FAIL, 9/11 passed, process exit `1`, elapsed 2.902 s. No other API baseline was rerun.
- The two failures were test-fixture coverage failures, not API errors: the company overview returned HTTP 200 with zero department detail rows, so the script had no department for the drill-down or out-of-scope scenarios. The isolated database has 3 D02 departments and 10 anonymous employees but zero `training_assignments` rows and zero registered assignment fixtures. Consequently neither failed case has an HTTP status or business error code of its own.

## 2026-09-05 statistics minimum-fixture rerun

- Existing D02 fixtures were reused for two departments and one anonymous employee in each department. No department or employee was added.
- One `[D04-TEST]` training plan and two assignments, spanning the company-admin and entity-admin department scopes, were created under the dedicated `D04-STATS-TEST-20260905` registry key.
- `verify-stats.js` was rerun exactly once after fixture preparation: PASS, 12/12 passed, process exit `0`, elapsed 4.565 s. The expanded total includes the certificate-target authority case that could not run without an out-of-scope department in the previous baseline.
- Automatic cleanup removed the temporary plan, assignments, fixture registrations, derived alert/read rows, and zero-value certificate target. Post-cleanup verification reported zero remaining D04 statistics fixture or derived rows.
- Statistics testing stops at this passing baseline; no statistics RPC, RLS, migration, or other business logic was changed.

## D04 closure candidate (2026-09-05)

### Repeatable minimum live E2E

`tests/e2e/d04-auth-home-smoke.js` is the minimum live E2E required for D04. It refuses any environment other than the configured isolated test project, starts an ephemeral localhost HTTP server, serves the real `index.html`, checks the application/authentication entry points, signs in through Supabase Auth, verifies the authenticated user, signs out, and closes the server. It does not create business data.

Latest result: PASS, 4/4 (`homepage 200`, `login 200`, `current user 200`, `logout 204`), elapsed 1.596 s. The local server was closed after the run.

### Repeatable data lifecycle

- D02 initialization remains `sql/test-environment-v1.sql` plus `sql/test-environment-v2-projects-storage.sql`, guarded by `D02_TEST_ONLY` and the isolated test database.
- Cleanup remains `tools/clear-test-fixtures.sql`, deleting only UUIDs registered in `safety_test_fixture_registry`.
- `tests/e2e/run-d04-stats-with-fixture.js` reproducibly reuses two D02 departments and two anonymous employees, creates the minimum plan and assignments, runs `verify-stats.js`, and cleans registrations plus all derived statistics rows in `finally`.
- The runner refuses a non-test environment, a project mismatch, a missing D02 marker, an incomplete statistics Schema, or a non-clean statistics baseline. Its post-cleanup assertion requires registry, plan, assignment, alert, alert-read, and certificate-target residue to all equal zero.

### Current baseline count

Counts are by D04 baseline group, not individual assertions:

| Status | Count | Groups |
| --- | ---: | --- |
| PASS | 3 | Static entry smoke (12/12); live homepage/auth E2E (4/4); statistics API baseline (12/12) |
| FAIL | 2 | Department API baseline (3/7); personnel API baseline (stopped after two permission failures) |
| Not implemented | 4 | Lint command; type-check command; unit-test runner; build command |
| Environment blocked | 0 | Isolated test database, D02 fixtures, test accounts, Node, PostgreSQL client, and local HTTP execution were available |

The two failing groups are recorded existing business baselines and do not trigger business repair in D04. Full seven-scenario browser business E2E remains outside this minimum skeleton and is still tracked under T25.

### Current API baseline and stability

No application API contract is frozen by D04. All application-specific entries below remain `draft` even when currently available.

| Interface | Current result | Permission / error evidence | Stability |
| --- | --- | --- | --- |
| Local `GET /` | Available; HTTP 200 with application and authentication entries | Localhost only | `draft` |
| Supabase `/auth/v1/token`, `/auth/v1/user`, `/auth/v1/logout` | Available; HTTP 200 / 200 / 204 | Isolated D02 test account only | External Auth API; application use is `draft` |
| Eight `stats_*` RPCs used by `verify-stats.js` | Available; 12/12 baseline passed | Expected entity denial is HTTP 403 / `42501`; allowed writes return 204 | `draft` |
| `create_department`, `delete_department` | Partially available in the existing baseline | Company create/delete passed; invalid entity request returned expected `P0001` | `draft` |
| Direct `profiles`, `departments`, `training_employees` reads used by legacy tests | Failed | HTTP 403 / `42501` | `draft`; existing business baseline issue |
| Personnel account/self-service RPC path | Not fully reached by the legacy test | Upstream direct table reads failed with HTTP 403 / `42501` | `draft` |

All D04 acceptance conditions are satisfied: a real repeatable minimum E2E exists, test data initialization/cleanup is documented and verified, all baseline categories are recorded, and available/failed/draft API states are explicit. The final R01 re-review reported `PASS` with no findings. D04 status is `PASS`; D05 is unlocked but was not started during D04 closure.

## R02 P1 remediation (2026-09-05)

- Added the shared `d04-test-environment.js` gate. Both real D04 runners now require `SAFETY_ENV=test`, matching API/database project references, and a positive read-only count for the fixed `D02-TEST-20260903` registry marker before any live API request.
- Authentication gate tests passed: missing D02 marker was rejected in 81 ms; `SAFETY_ENV=inspection` was rejected before authentication in 104 ms; the correct isolated environment completed homepage/login/current-user/logout 4/4 in 6.260 s.
- Added `run-d04-stats-with-fixture.js`. Its non-test rejection passed in 87 ms. Its isolated run created one `[D04-TEST]` plan and two assignments across two D02 departments, ran `verify-stats.js` once with 12/12 passing in 5.729 s, and completed the full guarded lifecycle in 21.119 s.
- The statistics runner's `finally` cleanup passed and asserted `registry|plan|assignments|alerts|reads|targets=0|0|0|0|0|0`. No statistics SQL, RLS, RPC, or business logic changed.
- Both R01 P1 findings are remediated. The subsequent short R01 re-review passed with no findings; D05 was not started.

## R03 final handoff (2026-09-05)

- Static entry smoke: PASS, 12/12.
- Repeatable live authentication E2E: PASS, 4/4 (`homepage 200`, `login 200`, `current user 200`, `logout 204`).
- Statistics API baseline: PASS, 12/12. The dedicated runner creates its minimum synthetic fixture, runs `verify-stats.js`, cleans in `finally`, and asserts `registry|plan|assignments|alerts|reads|targets=0|0|0|0|0|0`.
- Department and personnel API groups remain FAIL with HTTP 403 / business code `42501`. They are visible existing business baseline issues, not converted to passing results, and D04 does not repair them.
- The final R01 re-review reported PASS with no findings. No production environment was accessed, no `miniprogram/**` file was changed, and no secret or real personal data is part of the D04 deliverable.
- D04 is formally `PASS`. D05 is unlocked; D05 work has not started.

## Failure recording rule

Any failing live result must retain the D04 case id, mapped T25 acceptance item, expected/actual summary, severity and sanitized command output. Store screenshots or logs only under ignored `test-results/d04/`; never include personal data, passwords, access tokens or full identity numbers.

## Known baseline limits

- Four anonymous project-state fixtures, two private buckets and three account bindings exist in the isolated test project. Full cross-project, high-risk, pause/reopen, temporary-access and visitor flows are still not claimed as passed until their dedicated API/browser scenarios run.
- Browser UI execution needs an explicit local CDP setup; the legacy helpers use a fixed local debugging port and are not a maintained Playwright project.
- D04 intentionally does not repair functional defects discovered by the smoke suite; each failure is a tracked T25 item for the subsequent dedicated task.
