# GPUQ Console 0.1.2 — dataset scaling and administration

- Raise the immutable dataset manifest limit to 500,000 combined file/directory entries; keep the 64 MiB JSON bound.
- Parse the manifest once per local materialization and reuse a path index. Checkpoint transfer accounting in bounded batches, retaining conservative crash-safe reservations, per-chunk authorization and disk checks, resumability, and final content verification.
- Bound dataset workers at 2 GiB rather than 1 GiB to accommodate large validated manifests. GPU training services and their limits are unchanged.
- Add administrator-only `gpuctl data unregister NAME[@VERSION]` and `datasets.unregister`. Removal runs in a detached worker; use `gpuctl data status OPERATION_ID` to confirm its final result.
- Active leases forbid removal. Local replicas are evicted before registration metadata is archived under `.trash/unregister-*/registration`. Original approved source directories and source configuration are not automatically removed. External trusted rsync/NFS consumers must be quiesced by the administrator first.
- Failed cleanup is retryable, and uncertain asynchronous outcomes are reported as unknown rather than success. Existing owners and other versions are preserved when deleting one version.

See [the dataset guide](DATASETS.md) for authorization, recovery, and deployment details. This release does not deploy scheduler-priority or administrator-command changes being developed separately.

## Validation

```sh
npm test
npm run test:python
GPUQ_DATASET_LARGE=1 python3 tests/dataset-performance.test.py
```

The opt-in large test registers a real 450,000-entry manifest and calls list/status. It also exercises full copy planning, stopping deliberately before the first chunk: this is not a claim that 450,000 physical files were copied. Concurrency, lease protection, interrupted checkpoints, path checks, and safe unregister retries have dedicated tests.
