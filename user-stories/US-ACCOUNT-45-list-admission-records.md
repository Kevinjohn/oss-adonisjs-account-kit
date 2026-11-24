# US-ACCOUNT-45 — List admission records

As an authorised application approver, I want to review a page of admission records so that I can find pending requests and current decisions.

**Status:** Current when the admission approval requirement is enabled
**Access:** Actor must be admitted and `approval.authorize.list(actor, {})` must return exactly true.
**Entry:** Host-owned route calls `AccountAdmission.list({ actorId, status?, cursor?, limit? })`; no admission managed route is supplied.
**Documentation:** [Admission](../docs/guide/admission.md)
**Source:** [`src/admission/listing.ts`](../src/admission/listing.ts)
**Coverage:** [`tests/admission_listing.spec.ts`](../tests/admission_listing.spec.ts)

## Acceptance criteria

- `actorId` is required. Optional `status` is `pending`, `approved`, `rejected` or `revoked`; `limit` defaults to 25 and must be an integer from 1 to 100. Pass the opaque `nextCursor` from a prior page as `cursor`. Missing approval capability or invalid inputs are refused before loading the actor.
- The actor must be admitted and `approval.authorize.list(actor, {})` must return exactly `true`. This callback receives an empty context without a transaction.
- `{ items, nextCursor }` contains records linked to accounts, oldest first with an ID tiebreak. Omitted status includes all linked states; `pending` requires a request and no decision. Waiting bootstrap approvals are excluded. If an account is deleted between reads, its record is skipped and pagination still follows the source page.

## User flow

```mermaid
flowchart TD
 A["Approver requests a page with optional status, limit and cursor"] --> B{"Are listing available and the filters valid?"}
 B -->|No| C["Report refusal"]
 B -->|Yes| H{"Is the actor admitted and authorised?"}
 H -->|No| C
 H -->|Yes| D["Show matching records or an empty page"]
 D --> E{"Is a next cursor present?"}
 E -->|Yes| F["Request next page with that cursor"]
 F --> A
 E -->|No| G["Finish review"]
```

## Code flow

Scope: approval capability, actor eligibility, callback authorisation and bounded page query.

The runnable API example traces the controller and middleware entry in its [admission code flow](../examples/api/README.md#admission-code-flow).

```mermaid
flowchart TD
 A["AccountAdmission.list calls paginateAdmissions"] --> B{"Approval enabled, and limit, status and cursor valid?"}
 B -->|No| E["Throw capability or input error"]
 B -->|Yes| C{"Actor found and admitted, and authorize.list(actor, empty context) returns true?"}
 C -->|No| H["Throw unknown actor or authorisation error"]
 C -->|Yes| F["Query linked records by creation time and ID with filter, cursor and limit plus one"]
 F --> I["Project page records after reloading users; skip any deleted user"]
 I --> G["Return items and nextCursor from source page position, or null"]
```

**Code references:** [`AccountAdmission.list`](../src/admission/service.ts), [`paginateAdmissions`](../src/admission/listing.ts), [`listing tests`](../tests/admission_listing.spec.ts)
