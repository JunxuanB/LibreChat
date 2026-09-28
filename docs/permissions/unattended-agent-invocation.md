# Unattended agent invocation authority (design proposal)

**Status:** Proposed implementation contract. This is not an enabled auth mode, a token issuer, a consent grant, or an approval to change existing Scheduled Chats. Related to #13824 and #16157. The [MCP provider matrix](./unattended-mcp-providers.md) tracks the separate external-credential gate.

## Why a separate boundary is needed

Today a [trigger envelope](../../packages/api/src/agents/triggers/envelope.ts) names a `principal.userId`, and the host mints a short-lived, server-only [trigger token](../../packages/api/src/crypto/jwt.ts) for that user. [ScheduledTokenContext](../../packages/api/src/schedules/context.ts) identifies the existing schedule owner and root agent across a resume; it explicitly does **not** prove consent or authorize a mint. These are useful compatibility mechanisms, not an autonomous agent subject or a user-delegated consent record. The [MCP authority proof](../../packages/api/src/mcp/authority/README.md) is a separate, currently default-off check on MCP configuration and credential generations; it does not authorize an invocation.

The new decision belongs to an invocation authority service that receives an **authenticated host assertion**, not a body, event payload, serialized envelope, agent prompt, or callback supplied by a tool. An agent's durable `agent/<agent-id>` identity must be registered separately from its mutable definition and the runtime instance. In particular, an existing `agent_id` in a trigger is a _target selection_, not proof that the agent is its own authorization subject.

| Invocation mode | Authorization subject         | Attributed actor              | Required live authority                                                               | Token semantics                                                                                                                               |
| --------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| User-delegated  | The verified user             | Registered `agent/<agent-id>` | Expirable, revocable user consent **and** current user RBAC/agent/tool policy         | `sub` is the user; `act.sub` is the agent; an audience-bound token represents only the approved delegation. First release: read-only MCP use. |
| Autonomous      | Registered `agent/<agent-id>` | Same registered agent         | Current organization role assignment for that agent **and** agent RBAC/service policy | `sub` is `agent/<agent-id>`; `t_id` identifies the verified organization. No creator-user impersonation or borrowed user OAuth grant.         |

A third-party provider grant is neither of these. A successful agent token mint must never be treated as proof that an external MCP server authorized offline OAuth. The converse also holds: a valid MCP refresh token cannot supply agent identity, consent, or an organization role.

**Alternatives:** Reusing the existing user-scoped trigger JWT and adding an optional agent claim would require every old worker and receiving route to learn the new consent/role rule, and an old worker could still execute a new-mode delivery as a normal user. Requiring hosted STS for all invocations supplies an issuer but breaks self-hosted deployments and still cannot grant external MCP access. A host-injected authority boundary with separate, capable-worker routing costs a new verifier and consent/role store, but concentrates mode selection, revocation and denial without rewriting the legacy schedule path. This recommendation changes if a current issuer already proves both modes end to end, including a self-hosted verifier; adapt that issuer instead of minting a competing token.

## Proposed trusted flow

```text
Authenticated ingress / scheduled owner / verified binding
  -> identify existing user and registered root agent; attest calling workload
  -> resolve mode from server-owned configuration, not payload fields
  -> read current consent + user RBAC, or agent role + organization policy
  -> verify agent/tool/resource ceilings; mint short-lived, single-audience token
  -> service verifies issuer, signature, audience, expiry, subject/actor and tenant
  -> immediately before an MCP tool, recheck authority and external grant binding
```

The authority lookup is a service boundary, not a stored bearer in a run record. The caller supplies a verified, non-serializable invocation reference and a bounded resource/tool request; the service returns an authorized principal or a typed denial. Its checks and any token exchange must use authoritative, current records. A trusted host derives subject, tenant and workload from authentication and existing ownership/binding checks. Transport-level `principal`, request `agent_id`, event source, and resumed-job fields must be checked against that binding, never accepted as a mode or a different owner. A handoff may change the executing child agent, but not the root subject, tenant, consent/role ceiling, or third-party grant owner.

### Failure and rollout invariants

- Missing registration, invalid workload attestation, expired/revoked consent, inactive role, disallowed tool, or cross-tenant mismatch denies the action. An unavailable authority store fails closed and is retried only as an outage, not reported as missing consent. No fallback from autonomous to a human user or from an absent grant to an interactive session.
- Permission and grant revocation block **new** mints and new tool uses. Already issued single-audience tokens remain valid to their bounded expiry; serving APIs still verify claims and enforce current service policy. Document the maximum expiry and audit behavior before activation, rather than inventing a TTL here.
- Existing schedules, direct MCP OAuth, API keys, and the current trigger envelope continue to use their existing behavior. Do not infer a new mode from an optional field in a v1 envelope: an old worker might accept it without the new gate. New-mode deliveries need capability-aware routing or a coordinated versioned cutover; an incapable worker must not execute them. Rollback turns the new gate off and drains or rejects new-mode deliveries without breaking legacy schedules.
- ClickHouse-hosted runtimes may use IAM-owned STS and attested workload identity. Self-hosted LibreChat needs a supported verifier and issuer/attestation adapter **without** ClickHouse dependencies. In both cases the receiving service verifies the token for its own audience and enforces policy; a generic trigger JWT is not automatically an STS exchange or an MCP grant.
- The workload, issuer, verifier and grant methods are injected by the host. Do not place a global principal switch, refresh token, or mutable authority snapshot in an agent definition, prompt, job, trigger payload, tool input, log, or trace. Audit the user/agent, tenant, source, requested resource, decision and grant reference without serializing secrets.

## Next implementable slices (not delivered by this proposal)

1. Add registered agent identity, typed invocation-mode selection and durable, owner-scoped consent/role records behind a disabled release gate. Specify the actual token format/issuer, consent surface and self-hosted trust root before accepting a mint; distinguish consent for read-only MCP from separately approved writes and direct API calls.
2. Verify subject, actor, audience, tenant, workload and current authorization in a receiving-service contract test. Cover forged body/trigger, child handoff, denied role, expiry, revocation, storage outage, and two-way mixed-version processing. Run an attestation and restart test on both managed and self-hosted adapters.
3. Route a **single** authorized entry point through that boundary, rechecking before execution. Keep legacy runs unaffected. Extend only after the provider matrix and a separately authorized MCP grant meet their own gates.

**What would change this proposal:** An independently verified existing issuer and self-hosted verifier that already enforce both consent and agent role might let us adapt them rather than add another minting layer. A provider that cannot issue a grant narrow enough for a delegated use cannot be enabled simply because this identity contract is implemented. No token schema, consent UX or release gate is claimed to be complete here.
