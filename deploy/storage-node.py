#!/usr/bin/env python3
"""Strict trusted-node storage management adapter, not a public HTTP endpoint.

The executor constructs Principal from its authenticated control-plane identity
and calls dispatch(actor, request). No request role, owner, hostpath, authority
proof, endpoint, enable flag or garbage-collection action is accepted. Policy and
authority adapters are exclusively trusted constructor/configuration inputs.
This module does not change routing, runtime manifests or production services.
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("gpuq_storage_tier", Path(__file__).with_name("dataset-tier.py"))
T = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(T)


class StorageNode:
    def __init__(self, cache, *, policy=None, authorities=None, tier=None):
        self.cache = cache
        if tier is not None:
            if tier.cache is not cache or policy is not None or authorities is not None:
                raise ValueError("provide either a matching tier or trusted policy/authorities")
            self.tier = tier
            return
        policy = {} if policy is None else policy
        if not isinstance(policy, dict) or set(policy) - {"enabled", "budgetBytes", "highWater", "lowWater"}:
            raise ValueError("invalid trusted storage tier policy")
        self.tier = T.DatasetTier(cache, authorities=authorities,
                                  enabled=policy.get("enabled", False),
                                  budget_bytes=policy.get("budgetBytes"),
                                  high_water=policy.get("highWater", .8),
                                  low_water=policy.get("lowWater", .7))

    @classmethod
    def from_executor(cls, executor, *, authorities=None):
        """Root integrates the authenticated route; no remote config is inferred."""
        _, cache = executor.dataset_cache()
        return cls(cache, policy=executor.CONFIG.get("storageTier"), authorities=authorities)

    def status(self, actor, dataset=None, version=None):
        self.cache._actor(actor, admin=True)
        response = dict(enabled=self.tier.enabled, highWater=self.tier.high_water,
                        lowWater=self.tier.low_water, budgetBytes=self.tier.budget_bytes,
                        scope="datasets-only", automaticCollectionExposed=False,
                        capacity=self.cache.capacity(actor))
        if dataset is None and version is None:
            return response
        if dataset is None or version is None:
            raise ValueError("dataset and version are required together")
        state = self.cache.status(actor, dataset, version)
        with self.cache._locked():
            self.cache._record(actor, dataset, version)
            value = self.cache._tier(dataset, version)
            leases = self.cache._leases(dataset, version)
            receipt = None
            try:
                receipt = self.tier._receipt(actor, value, dataset, version)
            except (ValueError, OSError, TypeError, KeyError):
                pass
        verified = False
        if receipt is not None:
            try:
                with self.tier.authorities[receipt["authorityId"]].guard(actor, receipt["proof"]):
                    verified = True
            except (ValueError, OSError, TypeError, KeyError):
                pass
        response["version"] = dict(dataset=dataset, version=version, state=state["state"],
                                   role=value["role"], lastUsedAt=value["lastUsedAt"],
                                   pinCount=len(value["pins"]), leaseCount=len(leases),
                                   recoveryVerified=verified)
        return response

    def dispatch(self, actor, request):
        """Only status/plan/pin/unpin. Never trust request-supplied identity."""
        self.cache._actor(actor, admin=True)
        if not isinstance(request, dict) or not isinstance(request.get("op"), str):
            raise ValueError("invalid storage management request")
        op = request["op"]
        fields = set(request) - {"op"}
        if op == "status" and fields in (set(), {"dataset", "version"}):
            return self.status(actor, request.get("dataset"), request.get("version"))
        if op == "plan" and fields in (set(), {"neededBytes"}):
            return self.tier.plan(actor, needed_bytes=request.get("neededBytes", 0))
        if op in {"pin", "unpin"} and fields == {"dataset", "version", "pinId"}:
            pin_id = request["pinId"]
            T.D._identifier(pin_id)
            # Authority retention is not an ordinary manual-use pin. Removing
            # one requires explicit private reconciliation of every dependent
            # replica, not this convenience RPC.
            if pin_id.startswith("authority-"):
                raise ValueError("authority retention pins require private reconciliation")
            function = self.cache.pin if op == "pin" else self.cache.unpin
            return function(actor, request["dataset"], request["version"], pin_id)
        raise ValueError("unsupported operation or unrecognized storage request fields")
