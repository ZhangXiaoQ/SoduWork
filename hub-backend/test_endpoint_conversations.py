"""Offline endpoint persistence and non-destructive migration regression entry."""
import unittest


def load_tests(loader, standard_tests, pattern):
    return loader.loadTestsFromNames([
        "tests.test_runner_content_store", "tests.test_endpoint_conversation_migration", "tests.test_desktop_login_policy",
        "tests.test_endpoint_rpc", "tests.test_schedule_content", "tests.test_migration_admission",
        "tests.test_account_endpoint_import",
        "tests.test_cloud_content_migration",
    ])


if __name__ == "__main__":
    unittest.main(verbosity=2)
