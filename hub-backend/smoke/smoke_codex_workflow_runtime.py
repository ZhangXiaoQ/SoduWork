"""Offline contract smoke for strict Codex-backed SoduWork delivery workflows."""
from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./.smoke-codex-workflow.db"

from app.services import (  # noqa: E402
    agent_execution_options,
    agent_route_selection,
    agent_setup,
    ai_remote,
    cli_account_auth,
    local_base,
    workflow_runs,
)


ROOT = os.path.dirname(os.path.dirname(__file__))
passed = 0
failed = 0


def check(name: str, condition, detail=None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print("PASS", name)
    else:
        failed += 1
        print("FAIL", name, detail if detail is not None else "")


def manifest(name: str) -> dict:
    with open(os.path.join(ROOT, "plugins", name), encoding="utf-8") as stream:
        return json.load(stream)


def plugin_contracts() -> None:
    expected_versions = {
        "soduwork-bugfix-149.json": "1.0.7",
        "soduwork-change-149.json": "1.0.6",
    }
    for filename in ("soduwork-bugfix-149.json", "soduwork-change-149.json"):
        if is_public_snapshot() and filename == "soduwork-bugfix-149.json":
            print("SKIP private deployment template:", filename)
            continue
        data = manifest(filename)
        ai_nodes = [node for node in data["workflow"]["nodes"]
                    if node["type"] in ("ai", "ai_review")]
        check(filename + " immutable version",
              data["version"] == expected_versions[filename])
        check(filename + " all AI nodes use Codex",
              len(ai_nodes) == 3
              and all(node["config"].get("agentKind") == "local:codex"
                      for node in ai_nodes))
        check(filename + " locks Sol max strict",
              all(node["config"].get("model") == "gpt-5.6-sol"
                  and node["config"].get("reasoningEffort") == "max"
                  and node["config"].get("fallbackMode") == "strict"
                  for node in ai_nodes))
        check(filename + " AI is not pinned to deploy runner",
              all(not node["config"].get("runnerTags") for node in ai_nodes))
        evaluations = data.get("evaluations") or []
        check(filename + " declares two representative evaluations",
              len(evaluations) == 2
              and all(case.get("criteria") and case.get("expectedOutputs") == [
                  "scope.requirements", "scope.preflight"]
                      for case in evaluations), evaluations)
        if filename == "soduwork-change-149.json":
            scope = next(node for node in ai_nodes if node["key"] == "scope")
            implement = next(node for node in ai_nodes if node["key"] == "implement")
            check(filename + " treats feature delivery as full product work",
                  "不要求存在可复现缺陷" in scope["config"]["prompt"]
                  and "不得只实现后端" in implement["config"]["prompt"])
            check(filename + " evaluates complete and blocked routes",
                  {case["key"] for case in evaluations} == {
                      "complete-product-change", "missing-delivery-input"})
        else:
            check(filename + " evaluates reproducible and blocked routes",
                  {case["key"] for case in evaluations} == {
                      "reproducible-regression", "unreproducible-report"})
        quality = next(node for node in data["workflow"]["nodes"]
                       if node["type"] == "quality")
        commands = [command.get("argv") for command in quality["config"]["commands"]]
        if filename == "soduwork-bugfix-149.json":
            check(filename + " uses deterministic monorepo quality gate",
                  ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                   "-File", "ops/verify-soduwork-quality.ps1"] in commands, commands)



def route_contracts() -> None:
    prefs = workflow_runs.execution_preferences({
        "agentKind": "local:codex", "model": "gpt-5.6-sol",
        "reasoningEffort": "MAX", "fallbackMode": "strict",
    })
    check("reasoning effort is canonical", prefs["reasoningEffort"] == "max", prefs)
    route = workflow_runs.execution_route({}, {}, prefs, "implement")
    check("route preserves native execution contract",
          route["agentKind"] == "local:codex"
          and route["model"] == "gpt-5.6-sol"
          and route["reasoningEffort"] == "max"
          and route["fallbackMode"] == "strict", route)
    try:
        workflow_runs.execution_preferences({"reasoningEffort": "fast"})
    except ValueError:
        check("unknown reasoning effort is rejected", True)
    else:
        check("unknown reasoning effort is rejected", False)
    ready = agent_route_selection.model_readiness({}, "local:codex", "gpt-5.6-sol")
    check("native Codex model bypasses company catalog", ready["ok"], ready)
    unsafe = agent_route_selection.model_readiness({}, "local:codex", "bad model; rm")
    check("unsafe native model is rejected", not unsafe["ok"], unsafe)


def cli_contracts() -> None:
    cfg = {"codex_model": "gpt-5.6-sol", "codex_reasoning_effort": "max"}
    for resume in (False, True):
        args = local_base._codex_args("session", "work", ROOT, cfg, resume=resume)
        check(("resume" if resume else "start") + " locks model",
              "-m" in args and args[args.index("-m") + 1] == "gpt-5.6-sol", args)
        check(("resume" if resume else "start") + " locks max reasoning",
              'model_reasoning_effort="max"' in args, args)
    resume_args = local_base._codex_args("session", "work", ROOT, cfg, resume=True)
    check("resume keeps its reduced argument contract",
          "-C" not in resume_args and "-s" not in resume_args, resume_args)


def auth_contracts() -> None:
    check("logged-out agent is not dispatchable",
          not ai_remote._agent_usable({"key": "codex", "auth": "unauthed"}))
    check("authenticated agent is dispatchable",
          ai_remote._agent_usable({"key": "codex", "auth": "authed"}))
    check("legacy runner remains compatible", ai_remote._agent_usable({"key": "pi"}))
    # The local CLI status is authoritative. Unavailable status remains
    # unknown; key presence and cached files cannot prove native login.
    with (
        tempfile.TemporaryDirectory(prefix="soduwork-codex-auth-") as home,
        patch.dict(os.environ, {"CODEX_HOME": home, "OPENAI_API_KEY": ""}),
        patch.object(agent_setup, "_bin_of", return_value="fixture-codex"),
        patch.object(cli_account_auth, "_run", return_value=None) as status,
    ):
        check("unavailable CLI status remains explicitly unknown",
              agent_setup._auth_probe("codex")[0] == "")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "smoke-key"}):
            check("a static API key cannot replace unavailable CLI status",
                  agent_setup._auth_probe("codex")[0] == "")
            status.return_value = (1, "Not logged in")
            check("explicit CLI logout takes precedence over static API key",
                  agent_setup._auth_probe("codex")[0] == "unauthed")
            status.return_value = (0, "Logged in using ChatGPT")
            check("explicit CLI login is authenticated",
                  agent_setup._auth_probe("codex")[0] == "authed")
        check("auth probe asks only the local login status command",
              status.call_args.args == ("fixture-codex", ["login", "status"]))


def main() -> None:
    route_contracts()
    cli_contracts()
    auth_contracts()
    print(f"\ncodex workflow runtime smoke: {passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
