"""Resolve per-turn plugins on the owning desktop, keeping bodies off Hub."""
from . import local_base
from .runner_desktop_capabilities import DesktopCapabilities


async def prepare(machine, message):
    packet = message.get("pluginTurn")
    if not packet:
        return None
    ref = str(message.get("ref") or "")
    if (not getattr(machine, "desktop_owned", False) or not isinstance(packet, dict)
            or packet.get("operation") != "plugin.prepare"
            or (packet.get("args") or {}).get("ref") != ref):
        raise ValueError("插件只能在原会话所属的本人电脑执行")
    run = local_base._RUNS.get(ref) or local_base.rehydrate(ref)
    if not run:
        raise ValueError("原会话尚未恢复，请刷新后重试")
    cfg = run.get("cfg") or {}
    context = {"ref": ref, "cwd": run.get("ws"), "text": str(message.get("text") or ""),
               "readOnly": (run.get("accessPolicy") or {}).get("mode") == "readonly" or run.get("mode") == "plan",
               "capabilityIds": cfg.get("capabilityIds") or (run.get("ctx") or {}).get("requiredAgentCapabilities") or []}
    if not hasattr(machine, "_desktop_capabilities"):
        machine._desktop_capabilities = DesktopCapabilities(machine._write_local_rpc)
    result = await machine._desktop_capabilities.call({**packet, "_turnContext": context})
    if result.get("ok") is not True:
        raise ValueError(result.get("error") or "原电脑未能准备插件")
    return result["data"]


async def prepare_start(machine, ref, ctx, cfg):
    """Use the Runner-prepared workspace, never a path supplied by mobile."""
    packet = ctx.pop("pluginTurn", None)
    if not packet:
        return
    if (not getattr(machine, "desktop_owned", False) or not isinstance(packet, dict)
            or packet.get("operation") != "plugin.prepare"
            or (packet.get("args") or {}).get("ref") != ref
            or not ctx.get("workspacePrepared") or not ctx.get("workDir")):
        raise ValueError("插件首轮必须在所属电脑的已准备工作区执行")
    context = {"ref": ref, "cwd": ctx["workDir"], "text": str(ctx.get("brief") or ""),
               "readOnly": (ctx.get("accessPolicy") or {}).get("mode") == "readonly" or ctx.get("mode") == "plan",
               "capabilityIds": ctx.get("requiredAgentCapabilities") or []}
    if not hasattr(machine, "_desktop_capabilities"):
        machine._desktop_capabilities = DesktopCapabilities(machine._write_local_rpc)
    result = await machine._desktop_capabilities.call({**packet, "_turnContext": context})
    if result.get("ok") is not True:
        raise ValueError(result.get("error") or "原电脑未能准备插件")
    data = result["data"]
    ctx["brief"] = data["promptText"]
    ctx["conversationPlugins"] = data["plugins"]
    cfg["pluginResourceBundles"] = data["resourceBundles"]
