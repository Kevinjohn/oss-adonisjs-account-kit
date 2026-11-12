# User story template

A story records one meaningful user action and why it matters. Use actual permission roles,
visible control names and current form fields. Keep implementation contracts in the repository's
authoritative decision record, instructions in guides and runnable scenarios in the test suite.

Use [US-ACCOUNT-01](US-ACCOUNT-01-recover-password.md) as the repository-specific example. The format below is portable; replace its sample content with source-backed details. Keep the writing and maintenance guidance in this TEMPLATE.md, outside individual stories.
Omit the optional Coverage line when there is no useful test link. The field table is for form
actions; use the controls/results alternative below for actions without input fields. Adapt both
diagrams to the actual action rather than retaining the sample save flow. Repository story links are relative to this `user-stories/` directory; source and guide links in copied stories use `../` paths.

## Story example

````markdown
# US-AREA-NN — Action title

As a [role], I want to [action] so that [useful outcome].

**Status:** [Current / Hidden / Removed / Demo / Operator / Planned; explain unavailable entry]
**Access:** [Actual roles and relevant conditions]
**Entry:** [Screen, route and exact visible control, or explicitly unavailable]
**Documentation:** [Relevant guide](../docs/guide/getting-started.md)
**Source:** [Entry implementation](../src/password_reset.ts)
**Coverage:** [Relevant test, optional](../tests/password_reset_request.spec.ts)

## Acceptance criteria

| Field                 | Control        | Required/default/conditions                                                                   |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| [Exact visible label] | [Control type] | [Required/optional, default, limits, options, dependent choices, visibility, read-only state] |

- [Observable success result.]
- [Relevant cancellation, refusal and failure behavior.]

## User flow

```mermaid
flowchart TD
    A["Open the action"] --> B["Enter details"]
    B --> C{"Save or cancel?"}
    C -->|Cancel| D["Close without saving"]
    C -->|Save| E{"Accepted?"}
    E -->|No| F["See error and correct or retry"]
    F --> B
    E -->|Yes| G["See the saved result"]
```

## Code flow

Scope: [Whole path, or explicitly named shared boundary.]

```mermaid
flowchart TD
    A["Actual entry symbol"] --> B["Actual submit handler"]
    B --> C["Actual service or state action"]
    C --> D{"Operation succeeds?"}
    D -->|No| E["Actual error handling"]
    D -->|Yes| F["Actual persistence and UI reconciliation"]
```

**Code references:** [Entry](../src/password_reset.ts), [Handler](../src/http/managed.ts), [Service](../src/password_reset.ts)
````

## Actions without input fields

Replace the field table with a short list of controls and their visible results. Do not create
empty or artificial field rows. For example, an action without input fields could use:

```markdown
## Acceptance criteria

- **Dry run** reports the number of expired rows eligible for removal without deleting them.
- **Prune** removes rows that are still expired at deletion time and reports the counts removed.
```

Use the actual control and behavior in the product. Include confirmation controls and relevant
cancellation or failure results when they affect the action. Keep both diagrams in these stories.

## Writing and maintenance rules

- Use one story per meaningful outcome. An inseparable set of controls may share a story;
  independently useful actions deserve their own. Create and edit are distinct actions.
- Include every relevant field, including conditional and read-only fields. Record exact labels,
  required/optional state, defaults, limits, available options and dependent choices. For dynamic
  choices, describe their source and filtering rules rather than listing transient data.
- Link an identical shared field list and describe create/edit differences locally. Do not make
  readers chase several links to discover a form.
- Keep acceptance criteria concise and observable. Avoid detailed test scripts and exhaustive
  backend guarantees; keep those in tests and the authoritative decision record.
- Keep identifiers and filenames stable. Add the next unused identifier within the area. Retain
  intent and mark availability when a feature disappears, unless retirement is explicitly authorized.
- Use the availability definitions below. Explain unavailable entries and identify historical or
  intended controls clearly. Retention does not promise restoration or authorize new functionality.
- An optional **Coverage:** test link identifies supporting tests; it does not claim they were run.
  Keep runtime results separate from source-reviewed availability.
- Verify source rather than inheriting stale copy. Update the index (README.md), coverage matrix
  (COVERAGE.md), shared reference (REFERENCE.md) and decision gaps (GAPS.md) alongside affected stories.
  Adapt these names to the repository's established equivalents.
- Record differences between agreed targets and current implementation in the gaps record without
  silently changing either. “New” in the coverage matrix means newly documented, not newly implemented.

## Availability definitions

| Status   | Meaning                                                                 |
| -------- | ----------------------------------------------------------------------- |
| Current  | Exposed, subject to stated roles, configuration and conditions          |
| Hidden   | Implementation remains but its ordinary entry or trigger is unavailable |
| Removed  | Historical capability has no current product entry                      |
| Demo     | Available only in the specified demo context                            |
| Operator | Installation, hosting or recovery outside the ordinary application UI   |
| Planned  | Agreed target without an ordinary implemented journey                   |

Read Status with Access and Entry. A configured feature switch is a condition, not proof of removal.
Current describes availability, not a browser test result. Preserve equivalent repository status
semantics and explain their mapping where an established scheme differs.

## Diagram conventions

- Every story has User flow and Code flow sections, each containing a Mermaid flowchart. The first
  uses screens, actions, decisions and outcomes a person understands; the second names the actual
  implementation. Link supporting files under Code references.
- Keep diagrams focused on the action. Include meaningful choices, cancellation, refusal, failure
  and recovery where they affect the journey; avoid repeating every validation or security rule.
- Trace producers and consumers: entry, handler, state or service, persistence where applicable
  and resulting UI. A retained component or setter alone does not prove a reachable journey.
- Distinguish server writes, device preferences and read-only actions. Verify the demo's actual
  path. Do not infer server authorization from hidden controls.
- Code labels must name existing symbols or explicitly identify absent/intended controls. State
  the scope when a diagram stops at a shared boundary.
- For Hidden, Removed or Planned features, label the intended user flow as unavailable. Show the
  actual missing entry/trigger and retained support in the code flow without implying execution.
- Reconcile labels and branches against source. Parse changed Mermaid diagrams and inspect
  representative rendering; report any check that could not be completed. Syntax validation does
  not establish behavioral correctness or prove a browser journey was exercised.
