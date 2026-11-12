"""Accounting concurrency + migration in a newly-created local PostgreSQL cluster."""
import importlib.util
import os
import secrets
import tempfile
from pathlib import Path
import subprocess
import sys

BACKEND = Path(__file__).resolve().parents[1]


def run(backend, database_url, database, port, isolated_cluster):
    if not isolated_cluster:
        raise RuntimeError('Only a newly-created isolated PostgreSQL cluster is allowed')
    env = {**os.environ, 'AUTH_SECRET': secrets.token_hex(32),
           'ADMIN_PASS': secrets.token_hex(24), 'DATABASE_URL': database_url,
           'USAGE_ACCOUNTING_TEST_POSTGRES_URL': database_url, 'PYTHONIOENCODING': 'utf-8'}
    commands = [[sys.executable, '-m', 'alembic', 'upgrade', '0062_plugin_recommendation_cover'],
                [sys.executable, '-m', 'alembic', 'upgrade', 'head'],
                [sys.executable, '-B', '-m', 'unittest', '-v', 'test_usage_accounting']]
    with tempfile.TemporaryDirectory(prefix='soduwork-accounting-pg-data-') as data_root:
        env['SODUWORK_DATA_ROOT'] = data_root
        for command in commands:
            result = subprocess.run(command, cwd=backend, env=env, capture_output=True,
                text=True, encoding='utf-8', errors='replace', timeout=240,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            print(result.stdout + result.stderr, flush=True)
            if result.returncode:
                return result.returncode
        return 0


if __name__ == '__main__':
    spec = importlib.util.spec_from_file_location('isolated_accounting_pg', BACKEND / 'tests/org_memory_postgres.py')
    harness = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(harness)
    harness.run_checks = run
    sys.exit(harness.main())
