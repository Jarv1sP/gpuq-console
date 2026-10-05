# Automatic personal-container membership

This optional backend feature projects existing account and machine permissions
into an explicitly scoped personal-OCI cohort. Members keep using the normal
project and terminal commands; no extra registration or user-entered whitelist
is introduced. It does not change GPU quotas, allocate GPUs or stop jobs.

Both ends must be enabled by an administrator after container acceptance:

- Portal: `GPUQ_OCI_AUTO_COHORT_MACHINES` is a comma-separated list of existing
  machine IDs. Its default is empty (off).
- Each selected node: retain the verified `personalOci` capability configuration
  and explicit `owners` array, and add `autoOwners: true`. The backend maintains
  `autoOwnersRevision`; do not reset it while keeping the portal database.

Only enabled accounts with a positive grant on that machine enter the derived
cohort. Registration still grants zero resources. Account approval, suspension,
role changes and deletion notify membership asynchronously after the account
commit. Notifications are coalesced per node; an offline node never blocks or
rolls back registration or an account change. First OCI creation and admission
to an existing, node-confirmed OCI project still await a matching membership ACK.
Lists, status, shared/isolated projects and non-opted-in nodes do not synchronize.
An empty list revokes every new OCI admission. Existing
jobs are not killed by a membership change.

The sync operation is private to the authenticated execution bridge, not a
public API or CLI command. It atomically merges only cohort membership and its
monotonic version into the latest node configuration. Other keys are preserved.
Older requests cannot overwrite a later revision. Node or ACK failures prevent
the requested admission; there is no silent venv, quota-free unscoped or
privileged fallback. A later user request may independently verify the current
state, but the updater never automatically replays a failed write.

This is **not per-owner disk hard-quota provisioning**. Scoped OCI can be used
with the existing explicit `storageQuota: {enabled: false}` policy, but then a
member can consume shared data-volume capacity. Administrators must explicitly
accept that remaining storage-exhaustion risk, or first provision verified
kernel byte/inode quotas. Removing `owners` still requires the original hard-
quota gate; automatic membership does not relax it or enable filesystem quotas.

Deployment and node acceptance are separate from source/CI approval. Default-off
source merging does not enable containers on any machine.
