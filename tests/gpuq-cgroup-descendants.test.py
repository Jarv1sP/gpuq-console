"""GPU process attribution only; no host services, containers or GPU access."""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gpuq"))
from gpuq.backends import GpuDevice
from gpuq.coordinator import Coordinator, GpuFenceAuditError


class DescendantAttribution(unittest.TestCase):
    def test_container_descendants_preserve_lease_fencing(self):
        coordinator = object.__new__(Coordinator)
        coordinator.store = Mock()
        coordinator.store.get_job.return_value = {"share_gpu": False}
        root = "/user.slice/app.slice/gpuq-a.service"
        other = "/user.slice/app.slice/gpuq-b.service"
        statuses = {"A": SimpleNamespace(control_group=root),
                    "B": SimpleNamespace(control_group=other)}
        devices = (GpuDevice(0, "GPU-0", 24000, 100, 23900, 0, (123,)),)
        leases = [{"job_id": "J-a", "attempt_id": "A", "gpu_uuid": "GPU-0"}]
        for group in (root, root + "/libpod-payload-fixture", root + "/payload/ray/worker"):
            with self.subTest(group=group):
                coordinator.cgroup_for_pid = Mock(return_value=group)
                managed, external, collisions = coordinator._classify_processes(devices, statuses, leases, [])
                self.assertEqual(managed, {"GPU-0": {123}})
                self.assertEqual(external, {})
                self.assertEqual(collisions, [])

        for group in (None, "", "/", "relative", root + "-evil/child", root + "XYZ",
                      root + "/../other", root + "/./child", root + "//child",
                      root + "/", root + "/child\x00"):
            with self.subTest(untrusted=group):
                coordinator.cgroup_for_pid = Mock(return_value=group)
                managed, external, collisions = coordinator._classify_processes(devices, statuses, leases, [])
                self.assertEqual(managed, {})
                self.assertEqual(external, {"GPU-0": {123}})
                self.assertEqual([c.kind for c in collisions], ["leased-external-process"])

        coordinator.cgroup_for_pid = Mock(return_value=other + "/libpod-payload-fixture")
        collisions = coordinator._classify_processes(devices, statuses, leases, [])[2]
        self.assertEqual([(c.kind, c.process_attempt_id, c.lease_attempt_id) for c in collisions],
                         [("managed-process-wrong-lease", "B", "A")])
        collisions = coordinator._classify_processes(devices, statuses, [], [])[2]
        self.assertEqual([(c.kind, c.process_attempt_id) for c in collisions],
                         [("managed-process-without-lease", "B")])

        # A PID on multiple GPUs has one ownership observation per scan.
        devices += (GpuDevice(1, "GPU-1", 24000, 100, 23900, 0, (123,)),)
        coordinator.cgroup_for_pid = Mock(side_effect=[root + "/payload", other + "/payload"])
        collisions = coordinator._classify_processes(devices, statuses, leases, [])[2]
        coordinator.cgroup_for_pid.assert_called_once_with(123)
        self.assertEqual([(c.kind, c.process_attempt_id, c.gpu_index) for c in collisions],
                         [("managed-process-without-lease", "A", 1)])
        # A subsequent scan must read again, not keep stale process ownership.
        collisions = coordinator._classify_processes(devices[:1], statuses, leases, [])[2]
        self.assertEqual(collisions[0].process_attempt_id, "B")

        # Ambiguous roots fail globally, including shared-GPU contracts.
        coordinator.store.get_job.return_value = {"share_gpu": True}
        for invalid_root in (root, root + "/nested.service", "/", "relative", root + "//bad"):
            with self.subTest(invalid_root=invalid_root), self.assertRaises(GpuFenceAuditError):
                ambiguous = {"A": SimpleNamespace(control_group=root),
                             "B": SimpleNamespace(control_group=invalid_root)}
                coordinator._classify_processes(devices, ambiguous, leases, [])

        # Legitimate sharing still attributes each payload to its actual lease.
        devices = (GpuDevice(0, "GPU-0", 24000, 100, 23900, 0, (123, 456)),)
        leases += [{"job_id": "J-b", "attempt_id": "B", "gpu_uuid": "GPU-0"}]
        coordinator.cgroup_for_pid = Mock(side_effect=[root + "/payload", other + "/payload"])
        managed, external, collisions = coordinator._classify_processes(devices, statuses, leases, [])
        self.assertEqual(managed, {"GPU-0": {123, 456}})
        self.assertEqual(external, {})
        self.assertEqual(collisions, [])


if __name__ == "__main__":
    unittest.main()
