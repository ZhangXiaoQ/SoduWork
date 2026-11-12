"""Finite resource budget for Harness² user turns and refinement diagnostics."""
from __future__ import annotations

import json
import time
import threading
from typing import Callable

from .harness2_errors import StructuredFailure

MAX_CALLS = 7
MAX_SECONDS = 420.0
MAX_REQUEST_SECONDS = 300.0
MAX_OUTPUT_TOKENS = 8192
# A user turn replays the full task in four probes and three proposals. These
# are whole-turn accounting and per-request wire limits, respectively; the old
# diagnostic limits could reject the second stage of a normal Runner prompt.
# Always-on reasoning retains additional headroom within the phase allowance;
# controllable planning does not spend tokens on a second hidden planning loop.
# Preserve existing deadlines; streaming completion and output limits reduce
# avoidable work without rejecting previously valid slow model responses.
# Reservations and usage remain atomic for defensive shared-budget callers.
MAX_REPORTED_TOKENS = 128000
MAX_PROMPT_BYTES = 128000


class RefinementBudget:
    """Retain numeric accounting only; provider billing is observed after response.

    Transport timeouts and checks at request boundaries cannot guarantee a hard
    provider billing or wall-clock ceiling while an in-flight request is pending.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.started = clock()
        self.calls = 0
        self.reported_tokens = 0
        self._failed = False
        self._lock = threading.RLock()

    def _stop(self):
        self._failed = True
        raise StructuredFailure("refinement_budget")

    def _remaining(self) -> float:
        remaining = MAX_SECONDS - (self._clock() - self.started)
        if self._failed or remaining <= 0 or self.reported_tokens >= MAX_REPORTED_TOKENS:
            self._stop()
        return remaining

    @staticmethod
    def _tokens(usage: dict, names: tuple[str, ...]) -> int:
        for name in names:
            if name in usage:
                try:
                    return max(0, int(usage[name] or 0))
                except (TypeError, ValueError, OverflowError):
                    raise StructuredFailure("response_format") from None
        return 0

    def run(self, model: dict, messages: list[dict], complete, on_usage=None) -> str:
        """Run exactly one request; any failure prevents later requests."""
        from .harness2_provider import can_disable_reasoning
        with self._lock:
            self._remaining()
            if self.calls >= MAX_CALLS:
                self._stop()
            if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > MAX_PROMPT_BYTES:
                self._stop()
            limit = model.get("maxOutputTokens", MAX_OUTPUT_TOKENS)
            if type(limit) is not int or not 1 <= limit <= 262144:
                self._failed = True
                raise StructuredFailure("model_config")
            system = next((row.get("content", "") for row in messages if row.get("role") == "system"), "")
            # The trusted adapter supplies these phase markers, never user data.
            proposal = system.startswith("SODUWORK_HARNESS2_EDIT\n")
            allowance = 4096 if proposal else 2048
            if model.get("reasoning") is True and not can_disable_reasoning(model):
                allowance *= 2
            bounded_model = {**model, "maxOutputTokens": min(limit, allowance)}
            timeout = min(MAX_REQUEST_SECONDS, self._remaining())
            self.calls += 1

        def usage(tokens):
            # Account and forward real usage without masking a more specific
            # transport/response failure from this same call. Enforce the
            # cumulative budget after complete validates its response.
            count = (self._tokens(tokens, ("input_tokens", "input", "prompt_tokens"))
                     + self._tokens(tokens, ("output_tokens", "output", "completion_tokens")))
            with self._lock:
                self.reported_tokens += count
            if on_usage:
                on_usage(tokens)

        try:
            result = complete(bounded_model, messages, usage, timeout=timeout)
            with self._lock:
                self._remaining()
        except Exception:
            with self._lock:
                self._failed = True
            raise
        return result
