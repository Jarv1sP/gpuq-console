"""Slurm adapter tests: fake scheduler only, no subprocess/SSH/GPU allocation."""

import importlib.util
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

MODULE = Path(__file__).resolve().parents[1] / "deploy/slurm_backend.py"
SPEC = importlib.util.spec_from_file_location("slurm_backend_under_test", MODULE)
slurm = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = slurm
SPEC.loader.exec_module(slurm)


def policy(**changes):
    fields = dict(
        users={"member-one": slurm.UserPolicy("gpuuser1", frozenset({"gpu-a"}), frozenset({"normal"})),
               "member-two": slurm.UserPolicy("gpuuser2", frozenset({"gpu-b"}), frozenset({"batch"}))},
        partitions={"gpu-a": slurm.PartitionPolicy("rtx_test", 4, 24),
                    "gpu-b": slurm.PartitionPolicy("other_test", 8, 48)},
        qos=frozenset({"normal", "batch"}), default_partition="gpu-a", default_qos="normal",
        run_root="/srv/gpu-runs", image="/srv/gpu-images/pytorch-sha256-test.sqsh", time_minutes=60)
    fields.update(changes)
    return slurm.Policy(**fields)


def job(**changes):
    fields = dict(id=str(uuid4()), userId="member-one", username="测试用户", cards=2,
                  argv=["python", "train.py"], name="experiment", minVramGiB=20)
    fields.update(changes)
    return fields


class FakeScheduler:
    def __init__(self):
        self.calls = []
        self.active = {}
        self.history = {}
        self.next_id = 100
        self.submit_error = None
        self.queue_error = None
        self.account_error = None
        self.receipt = None
        self.hide_receipt_job = False
        self.confirm_cancel = True

    @staticmethod
    def option(command, key):
        return next(arg.split("=", 1)[1] for arg in command.argv if arg.startswith(key + "="))

    @staticmethod
    def line(record, accounting):
        values = [record[k] for k in ("id", "user", "name", "raw")]
        if accounting:
            values.append(record.get("exit", "0:0"))
        return "|".join(values + [record["comment"]]) + "\n"

    def __call__(self, command):
        self.calls.append(command)
        program = Path(command.argv[0]).name
        if program == "squeue":
            if self.queue_error:
                raise self.queue_error
            return "".join(self.line(row, False) for row in self.active.values()
                           if row["name"] == self.option(command, "--name"))
        if program == "sacct":
            if self.account_error:
                raise self.account_error
            return "".join(self.line(row, True) for row in self.history.values()
                           if row["name"] == self.option(command, "--name"))
        if program == "sbatch":
            jid = str(self.next_id)
            self.next_id += 1
            record = dict(id=jid, user=command.user, name=self.option(command, "--job-name"),
                          raw="PENDING", comment=self.option(command, "--comment"))
            if not self.hide_receipt_job:
                self.active[jid] = record
            if self.submit_error:
                raise self.submit_error
            return self.receipt if self.receipt is not None else jid + "\n"
        if program == "scancel":
            jid = command.argv[-1]
            if self.confirm_cancel:
                record = self.active.pop(jid)
                self.history[jid] = {**record, "raw": "CANCELLED by 1001", "exit": "0:15"}
            return ""
        raise AssertionError("Unexpected executable: " + program)

    def count(self, name):
        return sum(Path(c.argv[0]).name == name for c in self.calls)

    def finish(self, jid, state="COMPLETED", exit_code="0:0"):
        self.history[jid] = {**self.active.pop(jid), "raw": state, "exit": exit_code}


class Adapter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ledger = Path(self.temp.name) / "state.sqlite3"
        self.scheduler = FakeScheduler()
        self.policy = policy()
        self.backend = slurm.SlurmBackend(self.policy, self.ledger, self.scheduler)
        self.job = job()

    def test_submit_status_and_same_uuid_do_not_resubmit(self):
        result = self.backend.submit(self.job)
        self.assertEqual(result["state"], "PENDING")
        self.assertEqual(result["nodeJobId"], "100")
        self.scheduler.active["100"]["raw"] = "RUNNING"
        self.assertEqual(self.backend.submit(self.job)["state"], "RUNNING")
        self.assertEqual(self.backend.status(self.job)["state"], "RUNNING")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_concurrent_retries_share_the_same_dispatch(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.backend.submit(self.job), range(8)))
        self.assertTrue(all(result["nodeJobId"] == "100" for result in results))
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_revoked_grants_still_allow_reconciling_and_canceling_recorded_jobs(self):
        self.backend.submit(self.job)
        revoked = policy(users={"member-one": slurm.UserPolicy("gpuuser1", frozenset(), frozenset())})
        backend = slurm.SlurmBackend(revoked, self.ledger, self.scheduler)
        self.assertEqual(backend.submit(self.job)["state"], "PENDING")
        self.assertEqual(backend.status(self.job)["state"], "PENDING")
        self.assertEqual(backend.cancel(self.job)["state"], "CANCELED")
        with self.assertRaises(slurm.ValidationError):
            backend.submit(job())

    def test_uuid_payload_change_rejected_before_any_slurm_command(self):
        self.backend.submit(self.job)
        before = len(self.scheduler.calls)
        with self.assertRaisesRegex(slurm.ValidationError, "different request"):
            self.backend.submit({**self.job, "argv": ["python", "different.py"]})
        self.assertEqual(len(self.scheduler.calls), before)

    def test_submit_timeout_reconciles_on_retry_without_duplicate(self):
        self.scheduler.submit_error = subprocess.TimeoutExpired("sbatch", 20)
        result = self.backend.submit(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.scheduler.submit_error = None
        self.assertEqual(self.backend.submit(self.job)["nodeJobId"], "100")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_missing_ambiguous_submission_never_retries_even_after_restart(self):
        self.scheduler.hide_receipt_job = True
        self.scheduler.submit_error = subprocess.TimeoutExpired("sbatch", 20)
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")
        restarted = slurm.SlurmBackend(self.policy, self.ledger, self.scheduler)
        result = restarted.submit(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertIn("not resubmitting", result["error"])
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_crash_after_durable_intent_does_not_dispatch_on_recovery(self):
        # Simulates process death after committing attempted=1 but before sbatch.
        normalized = slurm.validate_job(self.job, self.policy)
        row = self.backend._get(normalized, create=True)
        row["attempted"] = 1
        self.backend._save(row)
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.count("sbatch"), 0)

    def test_accounting_outage_is_not_proof_of_absence(self):
        self.scheduler.account_error = slurm.ReconciliationError("accounting unavailable")
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.count("sbatch"), 0)
        self.scheduler.account_error = None
        self.assertEqual(self.backend.submit(self.job)["state"], "PENDING")

    def test_invalid_receipt_can_be_recovered_by_exact_marker(self):
        self.scheduler.receipt = "bad receipt\n"
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.backend.submit(self.job)["nodeJobId"], "100")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_receipt_alone_is_not_a_fake_pending_state(self):
        self.scheduler.hide_receipt_job = True
        result = self.backend.submit(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(result["nodeJobId"], "100")
        self.assertIn("awaiting authoritative", result["error"])

    def test_fast_finished_timeout_job_is_found_in_accounting(self):
        self.scheduler.submit_error = subprocess.TimeoutExpired("sbatch", 20)
        self.backend.submit(self.job)
        self.scheduler.finish("100")
        result = self.backend.submit(self.job)
        self.assertEqual(result["state"], "SUCCEEDED")
        self.assertEqual(result["exitCode"], "0:0")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_terminal_state_is_durable_if_old_accounting_is_purged(self):
        self.backend.submit(self.job)
        self.scheduler.finish("100")
        self.assertEqual(self.backend.status(self.job)["state"], "SUCCEEDED")
        self.scheduler.history.clear()
        restarted = slurm.SlurmBackend(self.policy, self.ledger, self.scheduler)
        self.assertEqual(restarted.submit(self.job)["state"], "SUCCEEDED")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_disappearance_of_running_job_stays_unknown(self):
        self.backend.submit(self.job)
        self.scheduler.active.clear()
        self.assertEqual(self.backend.status(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.count("sbatch"), 1)

    def test_owner_or_fingerprint_mismatch_cannot_adopt_or_cancel(self):
        self.backend.submit(self.job)
        original = self.scheduler.active["100"].copy()
        for key, value in (("user", "otheruser"), ("comment", ""), ("comment", "gpuq:forged")):
            with self.subTest(key=key, value=value):
                self.scheduler.active["100"] = {**original, key: value}
                result = self.backend.cancel(self.job)
                self.assertEqual(result["state"], "UNKNOWN")
                self.assertIn("mismatch", result["error"])
        self.assertEqual(self.scheduler.count("scancel"), 0)

    def test_duplicate_remote_allocations_are_not_arbitrarily_selected(self):
        self.backend.submit(self.job)
        self.scheduler.active["101"] = {**self.scheduler.active["100"], "id": "101"}
        result = self.backend.cancel(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertIn("conflicting", result["error"])
        self.assertEqual(self.scheduler.count("scancel"), 0)

    def test_reassigned_slurm_id_does_not_cancel_unrelated_allocation(self):
        self.backend.submit(self.job)
        row = self.scheduler.active.pop("100")
        self.scheduler.active["200"] = {**row, "id": "200"}
        result = self.backend.cancel(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.count("scancel"), 0)

    def test_cancel_only_uses_exact_owner_name_and_id(self):
        self.backend.submit(self.job)
        result = self.backend.cancel(self.job)
        self.assertEqual(result["state"], "CANCELED")
        command = next(c for c in self.scheduler.calls if c.argv[0].endswith("scancel"))
        self.assertEqual(command.user, "gpuuser1")
        self.assertEqual(command.argv, ("/usr/bin/scancel", "--ctld", "--user=gpuuser1", "--name=gpuq-" + self.job["id"], "100"))

    def test_cancel_receipt_is_not_terminal_until_slurm_confirms(self):
        self.backend.submit(self.job)
        self.scheduler.confirm_cancel = False
        result = self.backend.cancel(self.job)
        self.assertEqual(result["state"], "PENDING")
        self.assertTrue(result["cancelRequested"])

    def test_cancel_before_submission_is_durable_and_never_dispatches(self):
        self.assertEqual(self.backend.cancel(self.job)["state"], "CANCELED")
        self.assertEqual(self.backend.submit(self.job)["state"], "CANCELED")
        self.assertEqual(self.scheduler.count("sbatch"), 0)
        self.assertEqual(self.scheduler.count("scancel"), 0)

    def test_cancel_ambiguous_submission_keeps_reservation(self):
        self.scheduler.hide_receipt_job = True
        self.backend.submit(self.job)
        result = self.backend.cancel(self.job)
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.count("scancel"), 0)
        self.assertEqual(self.backend.submit(self.job)["state"], "UNKNOWN")

    def test_status_on_unknown_job_does_not_submit(self):
        self.assertEqual(self.backend.status(self.job)["state"], "UNKNOWN")
        self.assertEqual(self.scheduler.calls, [])

    def test_wrong_platform_owner_cannot_use_existing_uuid(self):
        self.backend.submit(self.job)
        altered = {**self.job, "userId": "member-two", "partition": "gpu-b", "qos": "batch"}
        with self.assertRaises(slurm.ValidationError):
            self.backend.cancel(altered)

    def test_ledger_refuses_symlinks_and_public_directories(self):
        alias = Path(self.temp.name) / "alias.db"
        alias.symlink_to(self.ledger)
        with self.assertRaises(OSError):
            slurm.SlurmBackend(self.policy, alias, self.scheduler)
        public = Path(self.temp.name) / "public"
        public.mkdir(mode=0o755)
        public.chmod(0o755)  # Explicit unsafe fixture even under umask 077.
        with self.assertRaisesRegex(slurm.ValidationError, "private"):
            slurm.SlurmBackend(self.policy, public / "ledger.db", self.scheduler)


class Builders(unittest.TestCase):
    def test_fixed_submit_options_and_literal_command_arguments(self):
        args = ["python", "space name.py", "$(touch /tmp/not-executed)", "x'; echo bad; '", "line\n#SBATCH --uid=root"]
        request = job(argv=args)
        command = slurm.build_submit(request, policy())
        self.assertEqual(command.user, "gpuuser1")
        self.assertEqual(command.argv[0], "/usr/bin/sbatch")
        for flag in ("--nodes=1", "--ntasks=1", "--gres=gpu:rtx_test:2", "--partition=gpu-a", "--qos=normal", "--export=NIL", "--no-requeue"):
            self.assertIn(flag, command.argv)
        task = shlex.split(command.stdin.split("exec ", 1)[1])
        self.assertEqual(task[task.index("--") + 1:], args)
        self.assertEqual(task[0], "/usr/bin/srun")
        self.assertIn("--container-readonly", task)
        self.assertIn("--no-container-mount-home", task)
        self.assertFalse(any(a.startswith(("--wrap", "--uid", "--get-user-env")) for a in command.argv))

    def test_advanced_gpuq_and_raw_slurm_options_are_explicitly_rejected(self):
        for field in ("priority", "mode", "yield", "restartPolicy", "gpuIndices", "fraction", "nodes", "sbatchArgs", "uid", "env"):
            with self.subTest(field=field), self.assertRaisesRegex(slurm.ValidationError, "Unsupported"):
                slurm.build_submit(job(**{field: "anything"}), policy())

    def test_user_partition_qos_and_numeric_limits_are_enforced(self):
        cases = [dict(userId="stranger"), dict(partition="gpu-b"), dict(qos="batch"),
                 dict(partition="gpu-a,--uid=root"), dict(qos="normal\n"), dict(cards=True),
                 dict(cards=0), dict(cards=5), dict(minVramGiB=25), dict(minVramGiB=float("nan")),
                 dict(minVramGiB=True), dict(argv=["--dangerous"]), dict(argv=["python", "\0"])]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(slurm.ValidationError):
                slurm.build_submit(job(**changes), policy())

    def test_policy_rejects_root_shared_linux_identity_and_mount_delimiters(self):
        user = slurm.UserPolicy("root", frozenset({"gpu-a"}), frozenset({"normal"}))
        with self.assertRaises(slurm.ValidationError):
            policy(users={"member-one": user})
        user = slurm.UserPolicy("user1", frozenset({"gpu-a"}), frozenset({"normal"}))
        with self.assertRaises(slurm.ValidationError):
            policy(users={"one": user, "two": user})
        for root in ("relative", "/", "/srv/a,other", "/srv/a:other", "/srv/../root", "/srv/%j"):
            with self.subTest(root=root), self.assertRaises(slurm.ValidationError):
                policy(run_root=root)

    def test_state_mapping_is_fail_closed_and_preserves_resource_holding_states(self):
        cases = {"PENDING": "PENDING", "CONFIGURING": "STARTING", "RUNNING": "RUNNING",
                 "COMPLETING": "RUNNING", "SUSPENDED": "RUNNING", "REQUEUED": "PENDING",
                 "CANCELLED by 1001": "CANCELED", "OUT_OF_MEMORY": "FAILED", "TIMEOUT": "FAILED",
                 "NODE_FAIL": "FAILED", "PREEMPTED": "FAILED", "COMPLETED+": "UNKNOWN", "NEW_STATE": "UNKNOWN"}
        for raw, state in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(slurm.normalize_state(raw), state)
        self.assertEqual(slurm.normalize_state("COMPLETED"), "UNKNOWN")
        self.assertEqual(slurm.normalize_state("COMPLETED", "0:0"), "SUCCEEDED")
        self.assertEqual(slurm.normalize_state("COMPLETED", "0:9"), "FAILED")
        self.assertEqual(slurm.normalize_state("COMPLETED", "2:0"), "FAILED")

    def test_cancel_rejects_array_step_and_option_injection_ids(self):
        for jid in ("", "--user=root", "1,2", "12_3", "12.batch", "12+1", "12;cluster"):
            with self.subTest(jid=jid), self.assertRaises(slurm.ValidationError):
                slurm.build_cancel("gpuuser1", "gpuq-" + str(uuid4()), jid)

    def test_malformed_status_output_is_not_an_empty_queue(self):
        for output in ("invalid", "1|u|n|RUNNING|c|extra", "1_2|u|n|RUNNING|c", "1.batch|u|n|RUNNING|c"):
            with self.subTest(output=output), self.assertRaises(slurm.ReconciliationError):
                slurm.parse_records(output, False)
        self.assertEqual(slurm.parse_records("", False), [])

    def test_status_queries_have_exact_filters_and_explicit_history_window(self):
        name = "gpuq-" + str(uuid4())
        queue, account = slurm.build_status("gpuuser1", name, "2026-01-02T00:02:00+00:00")
        self.assertIn("--name=" + name, queue.argv)
        self.assertIn("--user=gpuuser1", account.argv)
        self.assertIn("--starttime=2026-01-01T23:57:00", account.argv)
        self.assertIn("--allocations", account.argv)
        self.assertIn("--local", account.argv)
        self.assertIn("--states=all", queue.argv)

    def test_runner_drops_root_and_does_not_inherit_credentials_or_slurm_overrides(self):
        account = SimpleNamespace(pw_uid=1001, pw_gid=1001, pw_dir="/home/gpuuser1")
        command = slurm.Command("gpuuser1", ("/usr/bin/squeue", "--noheader"))
        with patch.object(slurm.pwd, "getpwnam", return_value=account), patch.object(slurm.os, "geteuid", return_value=0), \
             patch.object(slurm.os, "getgrouplist", return_value=[1001]), \
             patch.object(slurm.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="", stderr="")) as run, \
             patch.dict(os.environ, {"SECRET_TOKEN": "not-for-slurm", "SBATCH_WRAP": "bad", "SLURM_CLUSTERS": "other"}):
            self.assertEqual(slurm.run_command(command), "")
            _, kwargs = run.call_args
            self.assertEqual(kwargs["user"], 1001)
            self.assertEqual(kwargs["group"], 1001)
            self.assertFalse(set(kwargs["env"]) & {"SECRET_TOKEN", "SBATCH_WRAP", "SLURM_CLUSTERS"})
            self.assertNotIn("shell", kwargs)

    def test_runner_refuses_root_or_wrong_unprivileged_identity(self):
        command = slurm.Command("gpuuser1", ("/usr/bin/squeue",))
        for uid, effective in ((0, 0), (1001, 1002)):
            account = SimpleNamespace(pw_uid=uid, pw_gid=1001, pw_dir="/home/test")
            with self.subTest(uid=uid, effective=effective), patch.object(slurm.pwd, "getpwnam", return_value=account), \
                 patch.object(slurm.os, "geteuid", return_value=effective), self.assertRaises(slurm.ValidationError):
                slurm.run_command(command)


if __name__ == "__main__":
    unittest.main()
