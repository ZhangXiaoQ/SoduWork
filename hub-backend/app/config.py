"""Application configuration from environment variables and .env; keep secrets out of source code.

"""
import logging
import os
import secrets
import shutil
import tempfile
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("uvicorn.error")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Default to SQLite for local development; configure an async PostgreSQL URL for shared environments.
    database_url: str = "sqlite+aiosqlite:///./soduwork_hub.db"
    # Independently provisioned PostgreSQL database, never the Hub business DB.
    # Empty disables cloud app storage without affecting standalone apps.
    jiyong_database_url: str = ""
    jiyong_asset_dir: str = ""
    jiyong_max_spaces_per_user: int = Field(default=100, ge=1, le=10000)
    jiyong_max_records_per_space: int = Field(default=100000, ge=1)
    jiyong_max_asset_bytes_per_space: int = Field(default=268435456, ge=8388608)
    # SQLite is reserved for local development. Customer environments opt into
    # explicit production guardrails with SODUWORK_ENV=production.
    soduwork_env: str = "development"
    # auto: upgrade/adopt at startup (single-instance/dev); check: release job migrates first.
    db_migration_mode: str = "auto"
    # Enable before transcript migration; old peers then cannot refill Hub bodies.
    # Rolling upgrades keep legacy reads until every endpoint has acknowledged.
    soduwork_conversation_metadata_only: bool = False
    db_pool_size: int = Field(default=10, ge=1, le=100)
    db_max_overflow: int = Field(default=20, ge=0, le=100)
    db_pool_timeout: float = Field(default=15, ge=1, le=120)
    db_pool_recycle: int = Field(default=1800, ge=60)
    db_statement_timeout_ms: int = Field(default=30000, ge=0)

    # Empty URL preserves the single-process fast path. Redis is transport and
    # presence, NOT the source of truth for tasks, approvals or workflow events.
    cluster_redis_url: str = ""
    cluster_namespace: str = "soduwork"
    cluster_shared_files: bool = False
    cluster_lease_seconds: int = Field(default=15, ge=10, le=120)
    cluster_refresh_seconds: float = Field(default=2, ge=.5, le=10)
    cluster_max_inflight: int = Field(default=128, ge=8, le=1024)
    # Enable only after every SQL writer has the shared-cache invalidation hooks.
    auth_cache_enabled: bool = False
    auth_cache_fencing_enabled: bool = False
    auth_cache_generation: str = "1"
    # Pin the live Redis incarnation. Restart/restore requires a drained,
    # deliberate re-enable; restored snapshots must never revive old sessions.
    auth_cache_redis_run_id: str = ""

    # Bootstrap a superuser only when users is empty; later configuration changes do not update existing accounts.
    # Never retain known default passwords in source code or configuration defaults.
    # Development generates an unset password; other environments require explicit credentials.
    admin_user: str = "admin"
    admin_pass: str = ""

    # The HMAC signing secret controls token authenticity and must remain confidential.
    # Development generates an unset secret and persists it in .auth_secret.
    # Ignore that file in Git; shared workers reuse it. Production and test environments require a strong injected secret.
    auth_secret: str = ""
    token_ttl_hours: int = 168  # Seven days.

    cors_origins: str = "*"
    offline_after_seconds: int = 30
    # IM ingress and its worker require an explicit deployment opt-in.
    im_enabled: bool = False
    # Rolling client migration only. ``false`` rejects legacy device headers.
    # New clients always use short-lived Device sessions regardless of this flag.
    device_auth_compat: bool = True

    # Full-client updates.
    # Store installers under hub-backend/client-releases by default, optionally on a separate persistent volume.
    client_update_dir: str = ""
    # Base64-encoded 32-byte Ed25519 private key for local publication compatibility.
    # Prefer a restricted CLIENT_UPDATE_SIGNING_KEY_FILE mount so the long-lived Hub need not hold signing authority.
    # JSON object of trusted Ed25519 public keys. The checked-in trust file is
    # used when this is empty; an environment override supports controlled key rotation.
    client_update_public_keys: str = ""
    # Deployment Runner uploads a complete signed installer; keep the limit explicit.
    client_update_upload_max_mb: int = 1024
    # Dedicated read-only stable release feed; empty disables access.
    client_release_read_token: str = Field(default="", repr=False)


    # Logical node label; each worker also receives a unique process incarnation.
    hub_node_id: str = "hub-primary"
    hub_public_url: str = ""
    # Administrators register connector applications so employees do not need to copy access tokens.
    connector_oauth_key: str = ""
    connector_google_client_id: str = ""
    connector_google_client_secret: str = ""
    connector_microsoft_client_id: str = ""
    connector_microsoft_client_secret: str = ""
    connector_microsoft_tenant: str = "organizations"
    # Empty preserves existing shared Runner routing. Nonempty is an exact,
    # comma-separated allowlist for ordinary cloud conversations, not deployment.
    cloud_execution_runner_ids: str = ""
    # Hub-side dispatch only; independent/employee Runners retain local execution.
    hub_local_execution_enabled: bool = True
    oidc_http_timeout_seconds: int = 10

    # External integration polling for pull adapters such as GitLab.
    # Zero disables polling; positive values poll enabled integrations every N seconds. Webhooks and manual pulls remain available.
    poll_interval_seconds: int = 0
    # Refresh GitLab/Gerrit catalogs independently; zero disables refresh. Credentials reference registered clients only.
    repository_sync_interval_seconds: int = 900


    # GitLab adapter defaults, overridable per integration.
    # base_url and project are non-secret; keep tokens in .env rather than stored integration configuration.
    gitlab_base_url: str = ""      # For example, https://gitlab.example.com.
    gitlab_project: str = ""       # Project ID or group/subgroup/name path.
    gitlab_token: str = ""         # PRIVATE-TOKEN personal access token; keep it outside the database and repository.
    gitlab_verify_tls: bool = True

    # Optional vision preprocessing; the main model retains reasoning and delivery responsibilities.
    # Prefer VL_MODEL with its matching provider and credential maintained in the model catalog.
    # VL_BASE_URL and VL_API_KEY provide an environment-only fallback; never expose the key in source or responses.
    # Disable vision preprocessing by default and send original images to the selected native multimodal model.
    vl_model: str = ""
    vl_base_url: str = ""
    vl_api_key: str = ""
    vl_timeout_seconds: int = 120

    # Task attachment storage: MinIO or S3-compatible storage.
    # Use MinIO when minio_endpoint is set; otherwise use ignored local uploads/ storage for development.
    # Keep AK/SK credentials in .env, outside the database and repository.
    minio_endpoint: str = ""          # For example, minio.example.com, without a URL scheme.
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "file-storage"
    minio_secure: bool = True         # https
    attach_max_mb: int = 20           # Maximum size per file in MB.
    # Independent document-library storage.
    # local is the default; remote selects the first fully configured protocol; auto falls back to local when none is configured.
    # Existing files retain their recorded backend; all backends isolate object keys by user hash.
    library_storage_backend: str = "local"
    library_storage_dir: str = "uploads/library"
    library_remote_order: str = "minio,nfs"
    library_minio_endpoint: str = ""
    library_minio_access_key: str = ""
    library_minio_secret_key: str = ""
    library_minio_bucket: str = ""
    library_minio_secure: bool = False
    # Connect directly over TCP. NFSv3 discovers mount_port=0 through rpcbind; NFSv4.1 does not use mountd.
    library_nfs_host: str = ""
    library_nfs_port: int = 2049
    library_nfs_export: str = ""
    library_nfs_mount_port: int = 0
    library_nfs_version: str | int = "3"
    # NFSv4.1 uses a reserved source port by default for secure exports; Hub needs permission to bind it.
    library_nfs_reserved_port: bool = True
    library_nfs_uid: int = 65534
    library_nfs_gid: int = 65534
    library_nfs_timeout: float = 10
    # Library uploads intentionally have no application-level size cap. The
    # reverse proxy/object store can still enforce an operational limit when
    # a deployment needs one by setting LIBRARY_MAX_MB to a positive value.
    library_max_mb: int = Field(default=0, ge=0, le=4096)
    # Video generation results are larger than ordinary chat attachments. Keep
    # a dedicated bounded cap so document uploads stay small.
    video_max_mb: int = Field(default=256, ge=20, le=2048)

    # Automatic daily personal reports at REPORT_HOUR when enabled.
    # When disabled, reports remain available through explicit user or administrator actions.
    report_auto: bool = True

    # Automatic issue batching through services/autobatch.py.
    # Disabled by default because automatic dispatch can change code without an individual approval.
    # Preview batches through GET /api/v1/admin/autobatch before enabling execution.
    # Group by owner and repository; dispatch after autobatch_min tasks or autobatch_wait_min minutes.
    # Timed batches require at least two tasks and a configured ai_work_dir.
    autobatch_enabled: bool = False
    autobatch_min: int = 3
    autobatch_wait_min: int = 30
    autobatch_tick_seconds: int = 300     # Supervisor interval; no polling occurs while the global switch is disabled.
    # Prefer the configured delivery plugin when it is bound to the repository's project.
    # Otherwise use legacy direct dispatch without the plugin's release stages.
    autobatch_plugin_key: str = "software-delivery"
    # Select the configured executor, or an idle local executor when unspecified.
    # ai_work_dir belongs to the backend execution machine.
    # A managed executor cannot access that machine's local directory, so automatic selection must remain local.
    autobatch_assignee: str = ""
    # Code-delivery reconciliation runs independently of the automatic-dispatch switch.
    # Reconcile manually dispatched work too, without requiring a user to open task details.
    delivery_sweep_seconds: int = 120
    # Automatic milestone progression uses a per-task task.ms_auto flag.
    # Different tasks may independently require automatic progression or manual acceptance.
    ms_auto_tick_seconds: int = 90

    service_name: str = "soduwork-hub"
    version: str = "0.1.0"

    @property
    def is_dev(self) -> bool:
        """Treat local SQLite as development and PostgreSQL as production or test."""
        return "sqlite" in self.database_url.lower()

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def resolve_secrets(self) -> None:
        """Generate missing credentials only in development; other environments leave them unset
        for validate_security to reject. Persist the first generated auth_secret in the ignored
        .auth_secret file so restarts retain it. Generate an unset bootstrap admin password only
        for initial account setup and report setup through the development log."""
        production = self.soduwork_env.strip().lower() in {"prod", "production", "customer"}
        if production:
            return
        if not self.auth_secret:
            self.auth_secret = _load_or_create_auth_secret()
            log.warning("AUTH_SECRET 未配置：已生成随机签名密钥并持久化到 .auth_secret（该文件已 gitignore，请勿提交或外发）")
        if not self.admin_pass:
            self.admin_pass = secrets.token_urlsafe(18)
            password_file = _write_dev_admin_pass(self.admin_pass)
            # Never log the complete bootstrap password because startup logs may be collected or forwarded.
            log.warning(
                "ADMIN_PASS 未配置：已为本次启动生成随机引导密码 %s****（仅 users 表为空时使用一次）；"
                "完整口令已写入 %s —— 请尽快用它在管理端登录并改掉",
                self.admin_pass[:4], password_file,
            )

    def validate_security(self) -> None:
        """Reject missing or known default secrets and passwords outside development."""
        production = self.soduwork_env.strip().lower() in {"prod", "production", "customer"}
        if self.is_dev and not production:
            return
        issues = []
        if production and self.is_dev:
            issues.append("production requires PostgreSQL; SQLite is not allowed")
        if len(self.admin_pass) < 16:
            issues.append("admin_pass 至少需要 16 个字符，请在 .env 设强随机密码")
        if len(self.auth_secret) < 32:
            issues.append("auth_secret 至少需要 32 个字符，请在 .env 设强随机签名密钥")
        if production and self.cors_origins.strip() == "*":
            issues.append("production forbids CORS_ORIGINS=*; configure explicit origins")
        if production and self.device_auth_compat:
            issues.append("production requires DEVICE_AUTH_COMPAT=false")
        if production and not self.hub_public_url.strip():
            issues.append("production requires HUB_PUBLIC_URL")
        if issues:
            msg = "安全配置检查未通过（生产/测试环境禁止默认密钥）：\n  - " + "\n  - ".join(issues)
            log.error(msg)
            raise RuntimeError(msg)


def _write_dev_admin_pass(value: str) -> str:
    """Persist the development bootstrap password in the ignored .admin_pass file with mode 0600;
    logs expose only a masked prefix.
    """
    path = Path(".admin_pass")
    try:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent or "."), prefix=".admin_pass.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value + "\n")
        try:
            os.replace(tmp, path)
        except OSError:
            # Transparent encryption drivers may reject same-volume os.replace; fall back to copy and delete.
            shutil.copyfile(tmp, path)
            os.unlink(tmp)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        log.exception("无法写入 .admin_pass：引导口令只在本次启动日志里出现过一次")
    return str(path)


def _load_or_create_auth_secret() -> str:
    """Persist the development auth_secret beside other working-directory configuration using a
    temporary file and replacement so workers share the same signing secret.
    """
    path = Path(".auth_secret")
    try:
        value = path.read_text(encoding="utf-8").strip()
        if len(value) >= 32:
            return value
    except FileNotFoundError:
        pass
    except OSError:
        log.exception("读取 .auth_secret 失败，将生成新密钥（旧 token 会失效）")
    value = secrets.token_urlsafe(48)
    try:
        fd, tmp = tempfile.mkstemp(dir=str(path.parent or "."), prefix=".auth_secret.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value + "\n")
        try:
            os.replace(tmp, path)
        except OSError:
            # Transparent encryption drivers may report WinError 17 for same-volume replacement.
            # The copy/delete fallback weakens atomicity during concurrent initial worker startup.
            shutil.copyfile(tmp, path)
            os.unlink(tmp)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        log.exception("无法写入 .auth_secret：auth_secret 仅本次进程有效，重启后 token 会失效")
    return value


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.resolve_secrets()  # Initialize development secrets before other modules read auth_secret.
    return s
