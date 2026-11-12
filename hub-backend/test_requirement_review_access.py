"""Release entry for requirement review permissions and immutable receipts."""
import unittest


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromName("tests.test_requirement_review_access.RequirementReviewAccessTests")


if __name__ == "__main__":
    unittest.main()
