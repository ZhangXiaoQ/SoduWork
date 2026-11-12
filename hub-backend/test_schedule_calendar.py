"""Run all calendar, custom recurrence and timing migration regressions offline."""
import unittest


MODULES = (
    "tests.test_schedule_timing_rules",
    "tests.test_schedule_custom_rules",
    "tests.test_schedule_timing_migration",
)


def load_tests(loader, _standard_tests, _pattern):
    return loader.loadTestsFromNames(MODULES)


if __name__ == "__main__":
    unittest.main(verbosity=2)
