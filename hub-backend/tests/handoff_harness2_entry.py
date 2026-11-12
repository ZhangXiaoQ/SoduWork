"""Exercise real Harness2 refinement and handoff with synthetic model/vendor IO."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.services import acp_bridge, harness2_bridge
from tests.harness2_fixture_model import complete as fixture_complete, model_calls

native_init = acp_bridge.AcpBridge.__init__


def fixture_vendor(self, argv, *args, **kwargs):
    assert len(model_calls) == 7, "handoff must refine before starting the vendor"
    assert argv[0] == sys.executable and Path(argv[1]).name == "harness2_native.py", "only the native executor may be replaced"
    peer = str(Path(__file__).with_name("handoff_vendor_peer.py"))
    native_init(self, [sys.executable, peer, "harness2"], *args, **kwargs)


acp_bridge.AcpBridge.__init__ = fixture_vendor
harness2_bridge.complete = fixture_complete
raise SystemExit(harness2_bridge.main())
