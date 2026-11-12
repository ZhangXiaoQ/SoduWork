"""Auditable smoke-test tiers for SoduWork's release and environment gates."""
from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Mapping, Sequence

from public_source import INTERNAL_SMOKES, is_public_snapshot


# Release checks are offline, deterministic and safe to run against isolated data.
RELEASE_SMOKES = tuple(sorted((
    "test_desktop_capabilities.py",
    "test_endpoint_conversations.py",
    "test_automation_inbox_push.py",
    "test_cloud_sync_notifications.py",
    "test_client_domain_events.py",
    "test_client_push_compat.py",
    "test_stability_review.py",
    "test_stability_followup.py",
    "test_cloud_durability_migration.py",
    "test_cloud_execution_sync.py",
    "test_cloud_message_recovery.py",
    "test_conversation_turn_plugins.py",
    "test_conversation_turn_skills.py",
    "test_cloud_recovery.py",
    "test_runner_event_delivery.py",
    "test_runner_inventory_scope.py",
    "test_token_quota.py",
    "test_personal_model_quota.py",
    "test_im_primitives.py",
    "test_im_transport.py",
    "test_im_archive.py",
    "test_im_security.py",
    "test_im_international.py",
    "test_im_teams.py",
    "test_turn_correlation.py",
    "test_notify_alerts.py",
    "test_health_identity.py",
    "smoke/smoke_app_publication.py",
    "test_plugin_app_contracts.py",
    "test_jiyong_contract.py",
    "test_jiyong_cloud_data.py",
    "test_schedule_source_app.py",
    "test_schedule_calendar.py",
    "test_plugin_window_contracts.py",
    "test_agent_install_recovery.py",
    "test_agent_platform_installation.py",
    "test_requirement_projection.py",
    # The four other maintenance suites have their own release entries below.
    # Run every case under its module deadline rather than repeat all five in
    # one aggregate process that exceeds the same 300-second deadline.
    "test_requirement_review_access.py",
    "test_requirement_maintenance.py",
    "test_requirement_maintenance_policy.py",
    "test_handoff_maintenance_boundary.py",
    "test_notice_audience_regression.py",
    "smoke/smoke_video_plugin.py",
    "smoke/smoke_acp_runtime.py",
    "smoke/smoke_runner_images.py",
    "test_qwen_runtime.py",
    "smoke/smoke_acp_team_admin.py",
    "smoke/smoke_admin_security.py",
    "test_admin_projects.py",
    "test_schedule_router_domains.py",
    "test_schedule_account_ownership.py",
    "test_task_owner_access.py",
    "test_task_account_ownership.py",
    "test_account_task_isolation.py",
    "test_account_task_surfaces.py",
    "test_attachment_ownership_compat.py",
    "test_usage_account_keys.py",
    "test_realtime_account_scope.py",
    "test_task_notification_queries.py",
    "test_runner_input_cleanup.py",
    "test_runner_agent_bootstrap.py",
    "test_runner_linux_entry.py",
    "test_plugin_smoke_groups.py",
    "test_plugin_access.py",
    "smoke/smoke_agent_model.py",
    "smoke/smoke_agent_naming.py",
    "smoke/smoke_agent_product_design.py",
    "smoke/smoke_agent_switch.py",
    "smoke/smoke_ai_errand.py",
    "smoke/smoke_ai_followup.py",
    "smoke/smoke_ai_review.py",
    "smoke/smoke_ai_unreachable.py",
    "smoke/smoke_aidesk.py",
    "smoke/smoke_alert.py",
    "smoke/smoke_applicable_flows.py",
    "smoke/smoke_approval_revoke.py",
    "smoke/smoke_approvals_bulk.py",
    "smoke/smoke_artifacts.py",
    "smoke/smoke_audit_scope.py",
    "smoke/smoke_autobatch_flow.py",
    "smoke/smoke_automation_templates.py",
    "smoke/smoke_builtin_delivery_e2e.py",
    "smoke/smoke_capabilities.py",
    "smoke/smoke_change_hygiene.py",
    "smoke/smoke_change_password.py",
    "smoke/smoke_claude_thinking.py",
    "smoke/smoke_client_auth.py",
    "smoke/smoke_client_download.py",
    "smoke/smoke_client_release_bundle.py",
    "smoke/smoke_client_release_uploader.py",
    "test_client_release_upload_io.py",
    "smoke/smoke_client_release_pipeline.py",
    "smoke/smoke_client_update_api.py",
    "smoke/smoke_client_update_supersession.py",
    "test_client_update_format.py",
    "test_client_update_beta.py",
    "test_client_update_brand.py",
    "test_client_release_feed.py",
    "test_client_test_payload.py",
    "smoke/smoke_client_updates.py",
    "smoke/smoke_cluster_contract.py",
    "smoke/smoke_codex_cli.py",
    "smoke/smoke_codex_workflow_runtime.py",
    "smoke/smoke_commercial_gate.py",
    "smoke/smoke_console_merge.py",
    "smoke/smoke_context_recovery.py",
    "smoke/smoke_conversation_ui.py",
    "smoke/smoke_critical_plugin_evaluations.py",
    "smoke/smoke_current_device_dispatch.py",
    "smoke/smoke_database_backup.py",
    "smoke/smoke_delivery_audit.py",
    "smoke/smoke_delivery_board.py",
    "smoke/smoke_delivery_truth.py",
    "smoke/smoke_demo_console.py",
    "smoke/smoke_deploy_argv.py",
    "smoke/smoke_deploy_assert.py",
    "smoke/smoke_deploy_failkind.py",
    "smoke/smoke_desktop_control.py",
    "smoke/smoke_deployment_client_release.py",
    "smoke/smoke_deployment_fifo.py",
    "smoke/smoke_deployment_runner_binding.py",
    "smoke/smoke_devflow.py",
    "smoke/smoke_device_security.py",
    "smoke/smoke_dispatch_reconcile.py",
    "smoke/smoke_dispatch_reliability.py",
    "smoke/smoke_dsh_runtime.py",
    "smoke/smoke_enterprise_workflows.py",
    "smoke/smoke_environment_config.py",
    "smoke/smoke_execution_capabilities.py",
    "smoke/smoke_execution_context.py",
    "smoke/smoke_execution_context_http.py",
    "smoke/smoke_execution_event_policy.py",
    "smoke/smoke_execution_names.py",
    "smoke/smoke_execution_policy.py",
    "smoke/smoke_execution_sessions.py",
    "smoke/smoke_failure_exit.py",
    "smoke/smoke_flow_retired.py",
    "smoke/smoke_full_backup.py",
    "smoke/smoke_gate_contract.py",
    "smoke/smoke_gate_steps.py",
    "smoke/smoke_git_delivery_coalescing.py",
    "smoke/smoke_git_probe.py",
    "smoke/smoke_golden_delivery.py",
    "smoke/smoke_handoff.py",
    "smoke/smoke_human_task_routing.py",
    "smoke/smoke_identity.py",
    "smoke/smoke_inactive_team_members.py",
    "test_inbox_count.py",
    "test_database_telemetry.py",
    "smoke/smoke_live_view_cache.py",
    "smoke/smoke_local_metadata.py",
    "smoke/smoke_log_safety.py",
    "smoke/smoke_managed_agents.py",
    "smoke/smoke_managed_work_route.py",
    "test_workflow_route_policy.py",
    "test_plugin_binding_contract.py",
    "test_plugin_manifest_contract.py",
    "test_environment_contracts.py",
    "test_model_definition_contracts.py",
    "test_model_identifier_boundaries.py",
    "test_model_defaults.py",
    "test_flash_thinking_upgrade.py",
    "test_ai_proxy_usage_passthrough.py",
    "test_local_artifact_contract.py",
    "test_local_turn_outcome.py",
    "smoke/smoke_mcp_runner_probe.py",
    "smoke/smoke_mcp_ui.py",
    "smoke/smoke_merge_reauth.py",
    "smoke/smoke_model_alias.py",
    "smoke/smoke_model_concurrency.py",
    "smoke/smoke_noask.py",
    "smoke/smoke_office_plugins.py",
    "smoke/smoke_officecli_detection.py",
    "smoke/smoke_operations.py",
    "smoke/smoke_operations_insights.py",
    "smoke/smoke_personal_automation.py",
    "smoke/smoke_plugin_admin_guard.py",
    "smoke/smoke_plugin_advanced_draft.py",
    "smoke/smoke_plugin_audience.py",
    "smoke/smoke_plugin_capability_package.py",
    "smoke/smoke_plugin_client_api.py",
    "smoke/smoke_plugin_conversation.py",
    "smoke/smoke_plugin_employee_catalog.py",
    "smoke/smoke_plugin_evaluations.py",
    "smoke/smoke_plugin_governance.py",
    "smoke/smoke_plugin_identity.py",
    "smoke/smoke_plugin_marketplace.py",
    "smoke/smoke_plugin_mcp_gateway.py",
    "smoke/smoke_plugin_process.py",
    "smoke/smoke_plugin_ready.py",
    "smoke/smoke_plugin_rollout.py",
    "smoke/smoke_plugin_setup.py",
    "smoke/smoke_plugin_signatures.py",
    "smoke/smoke_plugin_ui.py",
    "smoke/smoke_plugin_ui_contract.py",
    "smoke/smoke_plugins.py",
    "smoke/smoke_product_coverage.py",
    "smoke/smoke_project_context.py",
    "smoke/smoke_project_org_adoption.py",
    "smoke/smoke_project_setup.py",
    "smoke/smoke_prompt_contract.py",
    "smoke/smoke_quality.py",
    "smoke/smoke_quality_config.py",
    "smoke/smoke_quality_manifest.py",
    "smoke/smoke_quality_runner.py",
    "smoke/smoke_redeploy.py",
    "smoke/smoke_release.py",
    "smoke/smoke_release_channels.py",
    "smoke/smoke_client_release_multichannel.py",
    "smoke/smoke_rework_backlog.py",
    "smoke/smoke_release_trust.py",
    "smoke/smoke_repository_assets.py",
    "smoke/smoke_repository_http.py",
    "smoke/smoke_responses_vision.py",
    "smoke/smoke_review_delivery_mode.py",
    "smoke/smoke_rework_delivery_progress.py",
    "smoke/smoke_rework_guard.py",
    "smoke/smoke_rollback.py",
    "smoke/smoke_route_tags.py",
    "smoke/smoke_run_close.py",
    "smoke/smoke_runner_admission.py",
    "smoke/smoke_runner_steering.py",
    "smoke/smoke_runner_capability_ui.py",
    "smoke/smoke_runner_enroll.py",
    "smoke/smoke_runner_fast_handshake.py",
    "smoke/smoke_runner_http_assertions.py",
    "smoke/smoke_runner_imports.py",
    "smoke/smoke_terminal_security.py",
    "smoke/smoke_runner_key.py",
    "smoke/smoke_runner_management.py",
    "smoke/smoke_runner_node_shim.py",
    "smoke/smoke_runner_quality.py",
    "smoke/smoke_runner_read_rpc_concurrency.py",
    "smoke/smoke_runner_release.py",
    "smoke/smoke_runner_route.py",
    "smoke/smoke_runner_rpc_concurrency.py",
    "smoke/smoke_runner_scm_rpc_concurrency.py",
    "smoke/smoke_runner_scope.py",
    "smoke/smoke_runner_shell_path.py",
    "smoke/smoke_runner_skill_refresh.py",
    "smoke/smoke_runner_ws_concurrency.py",
    "smoke/smoke_runtime_components.py",
    "smoke/smoke_schedule_expiry.py",
    "smoke/smoke_schedule_ledger.py",
    "smoke/smoke_scheduler_concurrency.py",
    "smoke/smoke_schedules.py",
    "smoke/smoke_schema_migrations.py",
    "smoke/smoke_script_tool.py",
    "smoke/smoke_server_image.py",
    "smoke/smoke_session_memory_http.py",
    "smoke/smoke_skill_scan_async.py",
    "smoke/smoke_skills.py",
    "smoke/smoke_smart_route.py",
    "smoke/smoke_soduwork_light_flows.py",
    "smoke/smoke_soduwork_self_deploy.py",
    "smoke/smoke_stage_agent.py",
    "smoke/smoke_stall_watch.py",
    "smoke/smoke_stability_hardening.py",
    "smoke/smoke_status_authority.py",
    "smoke/smoke_task_ai.py",
    "smoke/smoke_task_attachments.py",
    "smoke/smoke_task_commands.py",
    "smoke/smoke_task_evolution.py",
    "smoke/smoke_task_execution_options.py",
    "smoke/smoke_task_flow_ui.py",
    "smoke/smoke_task_frozen_routing.py",
    "smoke/smoke_task_trace.py",
    "smoke/smoke_task_transfer.py",
    "smoke/smoke_team_daily_report.py",
    "smoke/smoke_team_message.py",
    "smoke/smoke_update_nudges.py",
    "smoke/smoke_usage_ledger.py",
    "smoke/smoke_usage_privacy.py",
    "smoke/smoke_usage_rollup.py",
    "smoke/smoke_usage_stats.py",
    "smoke/smoke_vision_router.py",
    "smoke/smoke_work_catalog.py",
    "test_unified_requirements.py",
    "test_admin_requirement_dispatch.py",
    "test_unified_requirements_migration.py",
    "test_unified_requirements_acl.py",
    "test_approval_inbox_scope.py",
    "test_runner_package_sources.py",
    "test_cicd_workflow.py",
    "test_retired_scm.py",
    "test_optional_services.py",
    "test_code_account_retirement.py",
    "test_runner_licenses.py",
    "test_runner_quality_paths.py",
    "test_portable_workspace.py",
    "test_runner_admission_journal.py",
    "test_cloud_runner_admin.py",
    "test_cloud_environments.py",
    "test_personal_runner_access.py",
    "test_runner_management_migration.py",
    "test_plugin_policy_brand_compat.py",
    "test_plugin_resource_recovery.py",
    "test_skill_policy_concurrency.py",
    "test_ai_proxy_open_keepalive.py",
    "test_model_gateway_diagnostics.py",
    "test_task_parse_keepalive.py",
    "test_mcp_import_preview.py",
    "smoke/smoke_work_reports.py",
    "smoke/smoke_workdirs.py",
    "smoke/smoke_workflow_adoption.py",
    "smoke/smoke_workflow_inputs.py",
    "smoke/smoke_workflow_terminal_wakeup.py",
    "smoke/smoke_workspace_guard.py",
    "smoke/smoke_workspace_ui.py",
    "smoke/smoke_ws_frames.py",
    "smoke/smoke_zero_route.py",
    "test_acp_error_messages.py",
    "test_cloud_agent_inventory.py",
    "test_codex_runtime_home.py",
    "test_conversation_execution_switch.py",
    "test_connector_foundations.py",
    "test_connector_database_regressions.py",
    "test_connector_database_extra.py",
    "test_connector_database_protocols.py",
    "test_connector_catalog.py",
    "test_connector_probes.py",
    "test_runner_turn_selection.py",
    "test_runner_desktop_identity.py",
    "test_runner_handshake.py",
    "test_schedule_loop_isolation.py",
    "test_schedule_run_reconciliation.py",
    "test_skill_preferences.py",
    "test_skill_studio.py",
    "test_handoff_target_diagnostics.py",
    "test_acp_other_permissions.py",
    "test_codex_account_acp.py",
    "test_dsh_access_policy.py",
    "test_dsh_gateway.py",
    "test_execution_stream_identity.py",
    "test_runner_admission_history.py",
    "test_public_source.py",
    "test_darwin_process_tree.py",
    "test_harness2_engine.py",
    "test_harness2_lifecycle.py",
    "test_harness2_platforms.py",
    "test_harness2_regressions.py",
    "test_managed_agent_download.py",
    "test_opencode_runtime_config.py",
    "test_email_auth.py",
    "test_legal_publications.py",
    "test_email_account_migration.py",
    "test_integrated_migration_history.py",
    "test_account_privacy.py",
    "test_device_connections.py",
    "test_account_mail.py",
    "test_gitlab_auth.py",
    "test_gitlab_repository_issues.py",
    "test_github_repository_issues.py",
    "test_repository_issue_access.py",
    "test_repository_issue_migration.py",
    "test_repository_issue_sync.py",
    "test_requirement_execution_claim.py",
    "test_requirement_plan_claim.py",
    "test_requirement_edit_policy.py",
    "test_task_trace_lifecycle.py",
)))

# These remain offline, but need a real browser, a local listener or longer-lived
# child processes.  The extended profile includes all release checks plus these.
EXTENDED_SMOKES = (
    "smoke/smoke_access_policy.py",
    "smoke/smoke_access_scope.py",
    "smoke/smoke_access_transition.py",
    "smoke/smoke_client_render.py",
    "smoke/smoke_cloud_durable_execution.py",
    "smoke/smoke_codex_permissions.py",
    "smoke/smoke_deploy.py",
    "smoke/smoke_enterprise_delivery_http.py",
    "smoke/smoke_jiyong_cloud_postgres.py",
    "smoke/smoke_local_env_guards.py",
    "smoke/smoke_mcp_http.py",
    "smoke/smoke_mcp_transport.py",
    "smoke/smoke_model_transport_socket.py",
    "smoke/smoke_runner_single.py",
    "smoke/smoke_runtime_messages.py",
    "smoke/smoke_skill_read_scope.py",
    "smoke/smoke_stream_recovery.py",
    "test_agent_npm_runtime.py",
    "test_conversation_handoffs.py",
    "test_durable_file.py",
    "test_handoff_agent_fallback.py",
    "test_runner_dialogue.py",
    "test_runner_journal_long_paths.py",
    "test_runner_node_shim.py",
)

# Live checks may use a running Hub, Runner, model quota, credentials or business
# database.  They are never selected by release/extended profiles.
LIVE_SMOKES = (
    "smoke/smoke_agents.py",
    "smoke/smoke_ai_proxy.py",
    "smoke/smoke_approvals.py",
    "smoke/smoke_devflow_api.py",
    "smoke/smoke_execution_live.py",
    "smoke/smoke_gitcreds.py",
    "smoke/smoke_live_push.py",
    "smoke/smoke_models.py",
    "smoke/smoke_plugin_e2e.py",
    "smoke/smoke_runner_job.py",
    "smoke/smoke_runner_management_live.py",
    "smoke/smoke_runner_term.py",
    "smoke/smoke_skills_api.py",
    "smoke/smoke_stage_model.py",
)

PUBLIC_SOURCE = is_public_snapshot()
if PUBLIC_SOURCE:
    # Only a declared export may omit dedicated private-adapter checks. Generic
    # deployment, Git, quality and missing-adapter checks remain registered.
    RELEASE_SMOKES = tuple(name for name in RELEASE_SMOKES if name not in INTERNAL_SMOKES)
    EXTENDED_SMOKES = tuple(name for name in EXTENDED_SMOKES if name not in INTERNAL_SMOKES)
    LIVE_SMOKES = tuple(name for name in LIVE_SMOKES if name not in INTERNAL_SMOKES)

GROUPS: Mapping[str, tuple[str, ...]] = {
    "release": RELEASE_SMOKES,
    "extended": EXTENDED_SMOKES,
    "live": LIVE_SMOKES,
}

# Requirements enforced before a full live gate starts.  The general live-gate
# acknowledgement is handled separately by quality_gate.py.
LIVE_REQUIREMENTS: Mapping[str, tuple[str, ...]] = {
    "smoke/smoke_ai_proxy.py": ("SODUWORK_SMOKE_LIVE_AI=1",),
    "smoke/smoke_runner_job.py": ("SMOKE_ALLOW_LIVE_DB=1",),
}

UNSAFE_MARKERS = ("SMOKE_BASE", "SMOKE_ALLOW_LIVE_DB", "SODUWORK_SMOKE_LIVE_AI")


def scripts_for(profile: str) -> tuple[str, ...]:
    """Return the scripts run by a profile without silently mixing live state."""
    if profile == "release":
        return RELEASE_SMOKES
    if profile == "extended":
        return RELEASE_SMOKES + EXTENDED_SMOKES
    if profile == "live":
        return LIVE_SMOKES
    raise ValueError(f"unknown quality profile: {profile}")


def all_registered(groups: Mapping[str, Sequence[str]] = GROUPS) -> tuple[str, ...]:
    return tuple(name for names in groups.values() for name in names)


def audit_manifest(backend: Path, groups: Mapping[str, Sequence[str]] = GROUPS) -> list[str]:
    """Find omissions, duplicates and unsafe checks leaking into offline tiers."""
    errors: list[str] = []
    registered = all_registered(groups)
    counts = Counter(registered)
    duplicates = sorted(name for name, count in counts.items() if count > 1)
    if duplicates:
        errors.append("registered in more than one tier: " + ", ".join(duplicates))

    discovered = {path.relative_to(backend).as_posix() for path in (backend / "smoke").glob("smoke_*.py")}
    misplaced = sorted(path.name for path in backend.glob("smoke_*.py"))
    if misplaced:
        errors.append("smoke files must live in smoke/: " + ", ".join(misplaced))
    listed = set(registered)
    missing = sorted(discovered - listed)
    # Existing unittest entry scripts may also be explicitly release-gated.
    # Keep discovering every smoke automatically, while checking real files
    # rather than requiring registered scripts to have a smoke_ prefix.
    entry_scripts = {path.name for path in backend.glob("*.py")} | discovered
    stale = sorted(listed - entry_scripts)
    if missing:
        errors.append("unregistered smoke tests: " + ", ".join(missing))
    if stale:
        errors.append("registered smoke files do not exist: " + ", ".join(stale))

    offline = tuple(groups.get("release", ())) + tuple(groups.get("extended", ()))
    for name in offline:
        path = backend / name
        if not path.is_file():
            continue
        source = path.read_text(encoding="utf-8", errors="replace")
        markers = [marker for marker in UNSAFE_MARKERS if marker in source]
        if markers:
            errors.append(f"offline tier contains live marker ({'/'.join(markers)}): {name}")

    invalid_requirements = sorted(set(LIVE_REQUIREMENTS) - set(groups.get("live", ())))
    if invalid_requirements:
        errors.append("live requirements target non-live tests: " + ", ".join(invalid_requirements))
    return errors


def missing_live_requirements(environment: Mapping[str, str]) -> list[str]:
    missing: set[str] = set()
    for requirements in LIVE_REQUIREMENTS.values():
        for requirement in requirements:
            key, expected = requirement.split("=", 1)
            if environment.get(key) != expected:
                missing.add(requirement)
    return sorted(missing)
