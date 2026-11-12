"""Personal plugin follow-ups preserve the original execution and durable identity."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.services import conversation_turn_plugins as plugins, runner_turn_plugins
from app.services import runner_comments, runner_admission, local_base, local_stream


class TurnPluginsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.selection = [{"pluginId": "local:plugin-builder", "checksum": "a" * 64}]

    def test_descriptor_rejects_bodies_paths_duplicates_and_wrong_checksums(self):
        self.assertEqual(plugins.normalize(self.selection), self.selection)
        for value in [[{**self.selection[0], "instructions": "untrusted"}],
                      [{"pluginId": "../other", "checksum": "a" * 64}],
                      [{"pluginId": "local:plugin-builder", "checksum": "old"}], self.selection * 2]:
            with self.assertRaises(HTTPException):
                plugins.normalize(value)

    def test_admission_id_binds_plugin_version_but_not_renewable_ticket(self):
        message = {"text": "same", "pluginTurn": {"authorization": "old", "args": {"plugins": self.selection}}}
        original = runner_admission.comment_digest("same-ref", message)
        message["pluginTurn"]["authorization"] = "renewed"
        self.assertEqual(original, runner_admission.comment_digest("same-ref", message))
        message["pluginTurn"]["args"]["plugins"] = [{**self.selection[0], "checksum": "b" * 64}]
        self.assertNotEqual(original, runner_admission.comment_digest("same-ref", message))

    async def test_wrong_account_and_cloud_runner_are_rejected(self):
        with self.assertRaises(HTTPException):
            await plugins.validate(None, SimpleNamespace(user_ref="other"),
                SimpleNamespace(phase="committed",owner_user_id="owner"), "ref", self.selection)
        with self.assertRaises(ValueError):
            await runner_turn_plugins.prepare(SimpleNamespace(desktop_owned=False),
                {"ref":"ref", "pluginTurn":{"operation":"plugin.prepare","args":{"ref":"ref"}}})

    async def test_runner_uses_native_workspace_and_records_only_user_text(self):
        ref = "existing-plugin-test"
        packet = {"operation":"plugin.prepare", "args":{"ref":ref,"plugins":self.selection}}
        native = {"ws":"native-workspace", "mode":"plan", "cfg":{"capabilityIds":["files"]}}
        result = {"promptText":"original + desktop-resolved instructions",
                  "plugins":[{"pluginId":"local:plugin-builder","name":"builder"}],
                  "resourceBundles":[{"key":"builder","resources":[]}]}
        pipe = SimpleNamespace(call=AsyncMock(return_value={"ok":True,"data":result}))
        machine = SimpleNamespace(desktop_owned=True,_desktop_capabilities=pipe)
        with patch.dict(local_base._RUNS,{ref:native}), \
             patch.object(local_stream,"record_user_sync",return_value={"ok":True}) as record, \
             patch.object(local_stream,"comment_sync",return_value={"ok":True}) as send:
            value = await runner_comments.comment(machine,
                {"ref":ref,"turnId":"one","text":"original","pluginTurn":packet,
                 "_admitted":True,"recordUser":True}, lambda *_:[])
        self.assertTrue(value["ok"])
        context = pipe.call.call_args.args[0]["_turnContext"]
        self.assertEqual(context["cwd"],"native-workspace")
        self.assertTrue(context["readOnly"])
        self.assertEqual(record.call_args.args[1],"original")
        self.assertEqual(send.call_args.args[1],ref)
        self.assertEqual(send.call_args.args[2],result["promptText"])
        self.assertEqual(send.call_args.args[0]["pluginResourceBundles"],result["resourceBundles"])

    async def test_plugin_prepare_failure_never_sends_an_unaugmented_turn(self):
        with patch.object(runner_turn_plugins,"prepare",AsyncMock(side_effect=ValueError("version changed"))), \
             patch.object(local_stream,"comment_sync") as send:
            result=await runner_comments.comment(SimpleNamespace(),
                {"ref":"ref","text":"original","turnId":"one","_admitted":True,"pluginTurn":{"args":{}}},lambda *_:[])
        self.assertFalse(result["ok"])
        send.assert_not_called()

    def test_internal_dispatch_id_passes_real_desktop_capability_entry(self):
        import json
        import subprocess
        import tempfile
        from pathlib import Path
        from app.auth import verify_claims
        from app.api.desktop_capabilities import digest
        script = Path(__file__).parent / "tests/desktop_plugin_request_fixture.cjs"
        with tempfile.TemporaryDirectory(prefix="soduwork-plugin-request-") as root:
            selected = json.loads(subprocess.check_output(
                ["node", str(script), root, "catalog"], text=True, encoding="utf-8"))
            client, runner = SimpleNamespace(user_ref="owner"), SimpleNamespace(client_id="pc")
            ref, dispatch_id = "initial-ref", "handoff:" + "a" * 64
            packet = plugins.authorization(client, runner, ref, [selected], dispatch_id)
            self.assertRegex(packet["requestId"], r"^[A-Za-z0-9_-]{8,80}$")
            self.assertEqual(packet["requestId"], plugins.authorization(client,runner,ref,[selected],dispatch_id)["requestId"])
            self.assertNotEqual(packet["requestId"], plugins.authorization(client,runner,"other",[selected],dispatch_id)["requestId"])
            claims = verify_claims(packet["authorization"], token_type="desktop-capability")
            self.assertEqual(claims["digest"],digest({k:v for k,v in packet.items() if k != "authorization"}))
            result = subprocess.run(["node",str(script),root],input=json.dumps(packet),
                text=True,encoding="utf-8",capture_output=True,check=True)
            resolved = json.loads(result.stdout)
            self.assertEqual(resolved["plugins"][0]["pluginId"],selected["pluginId"])
            self.assertTrue(resolved["hasPrompt"])
            self.assertGreater(resolved["resourceCount"],0)
            legacy = plugins.authorization(client,runner,ref,[selected],"valid-existing-id")
            self.assertEqual(legacy["requestId"],"valid-existing-id")
            bad = {**packet,"requestId":dispatch_id}
            rejected = subprocess.run(["node",str(script),root],input=json.dumps(bad),
                text=True,encoding="utf-8",capture_output=True)
            self.assertNotEqual(rejected.returncode,0)
            self.assertIn("操作内容不正确",rejected.stderr)

    def test_new_chat_options_keep_only_pinned_plugin_identifiers(self):
        from app.services.cloud_conversations import clean_options
        base = {"sessionId":"mobile:new", "agentId":"pi", "text":"summarize", "plugins":self.selection,
                "targetRunnerId":"pc", "targetRunnerKind":"work-computer"}
        self.assertEqual(clean_options(base)["plugins"], self.selection)
        for changes in [{"targetRunnerKind":"cloud"}, {"targetRunnerId":""},
                        {"plugins":[{**self.selection[0], "prompt":"injected"}]}]:
            with self.assertRaises(HTTPException):
                clean_options({**base, **changes})
        plain = clean_options({k:v for k,v in base.items() if k != "plugins"})
        self.assertNotIn("plugins", plain)  # Preserve hashes of old pending requests.

    async def test_new_chat_requires_owner_and_explicit_start_protocol(self):
        from app.services import runner_hub
        from app.api import desktop_capabilities
        runner = SimpleNamespace(client_id="pc", caps=["desktopPluginTurn1", "admit1"])
        with patch.object(runner_hub,"get",return_value=runner), \
             patch.object(desktop_capabilities,"resolve",AsyncMock(return_value=(None,runner))) as resolve:
            with self.assertRaises(HTTPException):
                await plugins.validate_start(None, SimpleNamespace(user_ref="owner"), "pc-runner")
            runner.caps.append("desktopPluginStart1")
            self.assertIs(await plugins.validate_start(None, SimpleNamespace(user_ref="owner"), "pc-runner"),runner)
            resolve.side_effect=HTTPException(403,"not owner")
            with self.assertRaises(HTTPException):
                await plugins.validate_start(None, SimpleNamespace(user_ref="other"), "pc-runner")

    async def test_first_turn_resolves_in_prepared_workspace_without_pc_sync(self):
        ref="initial-ref"
        packet={"operation":"plugin.prepare","args":{"ref":ref,"plugins":self.selection}}
        result={"promptText":"work + verified method", "plugins":[{"pluginId":"local:plugin-builder"}],
                "resourceBundles":[{"key":"builder", "resources":[]}]}
        pipe=SimpleNamespace(call=AsyncMock(return_value={"ok":True,"data":result}))
        machine=SimpleNamespace(desktop_owned=True,_desktop_capabilities=pipe)
        ctx={"pluginTurn":packet,"workspacePrepared":True,"workDir":"runner-owned-workspace",
             "brief":"work","conversationUserText":"work","requiredAgentCapabilities":["files"],
             "accessPolicy":{"mode":"readonly"}}
        cfg={}
        await runner_turn_plugins.prepare_start(machine,ref,ctx,cfg)
        sent=pipe.call.call_args.args[0]
        self.assertEqual(sent["_turnContext"]["cwd"],"runner-owned-workspace")
        self.assertEqual(sent["_turnContext"]["capabilityIds"],["files"])
        self.assertTrue(sent["_turnContext"]["readOnly"])
        self.assertEqual(ctx["brief"],result["promptText"])
        self.assertEqual(ctx["conversationUserText"],"work")
        self.assertEqual(ctx["conversationPlugins"],result["plugins"])
        self.assertEqual(cfg["pluginResourceBundles"],result["resourceBundles"])
        self.assertNotIn("pluginTurn",ctx)
        for changes in [{"workspacePrepared":False}, {"workDir":""},
                        {"pluginTurn":{**packet,"args":{"ref":"other"}}}]:
            with self.assertRaises(ValueError):
                await runner_turn_plugins.prepare_start(machine,ref,{**ctx,"pluginTurn":packet,**changes},{})
        pipe.call.return_value={"ok":False,"error":"version changed"}
        with self.assertRaisesRegex(ValueError,"version changed"):
            await runner_turn_plugins.prepare_start(machine,ref,{**ctx,"pluginTurn":packet},{})


if __name__ == "__main__":
    unittest.main()
