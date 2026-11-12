"""Offline release entry for Harness2 and managed OpenCode regression suites."""
import unittest


MODULES = (
    "tests.test_harness2_native_executor",
    "tests.test_harness2_native_safety",
    "tests.test_harness2_native_provider",
    "test_harness2_native_web",
    "tests.test_harness2_bridge",
    "tests.test_harness2_budget",
    "tests.test_harness2_latency",
    "tests.test_harness2_errors",
    "tests.test_harness2_events",
    "tests.test_harness2_interactive",
    "tests.test_harness2_refinement_errors",
    "tests.test_harness2_setup_probe",
    "tests.test_harness2_transport",
    "tests.test_opencode_dependencies.OpenCodeDependenciesTests",
    "tests.test_opencode_install_readiness",
    "tests.test_opencode_setup_readiness",
)


def load_tests(loader, tests, pattern):
    # Native installation is opt-in and intentionally absent from release CI.
    return unittest.TestSuite(loader.loadTestsFromName(name) for name in MODULES)


if __name__ == "__main__":
    unittest.main()
