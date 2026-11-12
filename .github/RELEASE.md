# Public GitHub releases

## Scope and status

`ci.yml` and `security.yml` run ordinary push/PR checks and provide the shared quality gates for `release.yml`. Release branch pushes and tags do not trigger duplicate checks. Client tests run on Linux and Windows; source HTTP startup checks run on all three operating systems. The PostgreSQL job checks migrations, schema drift, backup and restore using a disposable database.

**Public release** offers three manual paths: source, Client and Hub. Client and Hub preflight fails while `PUBLIC-SOURCE.json` sets `sourceOnly: true`, any item in `third-party/public-release.json` is pending, or previous-installer baselines are missing. The source path does not depend on these gates. `SODUWORK_INTERNAL_BUILD` cannot bypass publication gates. Workflow source does not establish a successful GitHub-hosted run.

| Component | Build and acceptance | GitHub Release assets |
| --- | --- | --- |
| source | Export the committed tree; verify the file inventory, public boundary and shared quality gates | Source ZIP without Git history |
| client | Windows fresh installation, repair, upgrade and compatibility; Mac DMG, signature, restart and upgrade; installation, startup, upgrade and removal in Ubuntu 22/24 and Rocky 9 containers; Android release build, signature/package inspection, emulator install, launch and cleanup | Windows x64 EXE, Linux x64 DEB/RPM/tar.gz, Mac ARM64/x64 DMG, Android APK |
| hub | Public self-hosting Dockerfile; disposable PostgreSQL, migrations, health/readiness, frontend assets, restart, image export and reload | Linux amd64 Docker image tar.gz |

Automated acceptance does not cover interactive Windows UAC or customer filesystem filters. Public macOS builds require a Developer ID Application identity, hardened runtime, notarization and a real login Keychain smoke test. The manual package-validation workflow intentionally keeps ad-hoc signatures and mock Keychain isolation; those artifacts are never eligible for publication. Hub acceptance uses one isolated node, without production deployment, real-model calls or browser interaction certification. Receipts record these limitations.

Before running the public Client release, configure these repository or environment secrets: `SODUWORK_MAC_CERTIFICATE_B64`, `SODUWORK_MAC_CERTIFICATE_PASSWORD`, `SODUWORK_MAC_KEYCHAIN_PASSWORD`, `SODUWORK_MAC_SIGN_IDENTITY`, `SODUWORK_MAC_NOTARY_KEY_ID`, `SODUWORK_MAC_NOTARY_ISSUER` and `SODUWORK_MAC_NOTARY_PRIVATE_KEY_B64`. The workflow imports the Developer ID certificate into an ephemeral keychain, stores the `notarytool` profile, and removes both after the job. It appends this keychain to the existing search list so the login Keychain remains accessible, then restores the original list on cleanup or a preparation failure. The release build fails closed when the identity is missing or notarization is disabled. The runner must also be logged into a disposable macOS account whose login Keychain can authorize the signed application; release acceptance sets `SODUWORK_MAC_REAL_KEYCHAIN=1` and writes synthetic ciphertext into an isolated profile and requires later restart and upgrade processes to decrypt those same bytes. Missing, corrupt or unreadable ciphertext fails acceptance instead of being replaced.

For migration from an older ad-hoc-signed macOS release, its reviewed baseline entry may explicitly set `notarization: "legacy-ad-hoc"`. Acceptance verifies its SoduWork identity, older version, exact artifact path and pinned SHA-256 before extraction, then still requires a strict bundle signature. Only that old baseline is exempt from Gatekeeper and stapled-ticket checks, and the exception is recorded in the receipt. New candidate packages always require both checks. Do not mark the candidate as a legacy baseline.

## Repository setup

To validate packaging before publication approval, set `PACKAGE_VALIDATION_REPOSITORY`
to this repository's `owner/name` and manually run **Native package validation**.
It builds Windows x64, Linux x64 (DEB/RPM/tar.gz), Mac ARM64/x64 and Android on
native GitHub-hosted runners. Android uses Flutter 3.47.7 and a disposable test
signing key, then installs and launches the APK in an emulator. Each job uploads
only its build/checksum report. Installers stay on the ephemeral runner while
binary distribution review remains pending. This workflow neither creates a
Release nor supplies upgrade-acceptance receipts to `Public release`.

1. Set the repository variable `PUBLIC_RELEASE_REPOSITORY` to the final public repository's `owner/name`. The workflow must exist on the default branch before its manual entry appears in Actions. The public branch must include the reviewed `mobile/` Flutter source before selecting the Client path; a missing mobile source is a hard failure.
2. Protect `release/source-*`, `release/client-*` and `release/hub-*`, prohibit force pushes and restrict updates to maintainers. Protect `source-v*`, `client-v*` and `hub-v*`; prohibit moving or deleting published tags.
3. Create the `public-release` Environment in advance, configure **Required reviewers**, restrict deployment to protected release branches and disable administrator bypass. Configure self-review according to team responsibilities. Preflight checks the actual reviewer gate through the GitHub API and fails if it is missing; it does not rely on YAML to create the environment automatically.
4. Keep `GITHUB_TOKEN` read-only by default. Only the approved publication job receives `contents: write` and `actions: read`. Do not configure company credentials, cluster addresses, private registries, upload tokens or SSH keys. PR jobs receive no release credentials; these workflows do not use `pull_request_target` or self-hosted runners.
5. Allow the official checkout/setup/artifact actions pinned to commit SHAs. Artifacts are downloaded from the current run; final publication uses the candidate's immutable artifact ID. Candidates are retained for 30 days and must be approved before expiry. Expired or missing artifacts require a new candidate, not receipts borrowed from another run.
6. Configure `SODUWORK_ANDROID_KEYSTORE_B64`, `SODUWORK_ANDROID_KEYSTORE_PASSWORD`, and (optionally) `SODUWORK_ANDROID_KEY_ALIAS` as Actions secrets. The signing key must be dedicated to the public Android application and must never be committed. The Android job uses an ephemeral API 35 emulator for install, launch and cleanup acceptance.

## Release procedure

1. Create `release/<component>-X.Y.Z` from reviewed public source. Client package/version/lock fields and the Android `pubspec.yaml` version must agree. Source and Hub versions are frozen by the branch and input, recorded in receipts, and also written to Hub OCI labels.
2. Manually run **Public release** on that branch with the matching component and version. Build and accept each candidate once. A source fix creates a new SHA and requires a new candidate.
3. After candidate preparation, stop at the `public-release` approval gate. For preparation-only work, do not create a formal tag or approve publication.
4. Review the receipts, create `component-vX.Y.Z` at **the same SHA**, then approve the original run. Before publishing, the workflow rechecks the remote release branch head, lightweight or annotated tag, source version, run ID, all platform receipts and file digests.
5. Create a draft Release, upload the original bytes and download each asset for verification. Publish only after all checks pass, then verify complete anonymous downloads. Never rebuild or overwrite assets. Retry only the publication job after a network failure. A draft from the same run can resume; a Release belonging to another run or containing different bytes is rejected.
6. Preserve the release branch head and tag. Merge release completion work into the public mainline while preserving history. New changes belong to a new version.

When preparing the public repository, reviewed source may be squashed into `public` without private development history, old tags or internal artifacts. The source exporter creates a ZIP from the committed tree, generates its manifest from the archived bytes, and verifies the archive before returning it. The manifest is not tracked in Git.

## Binary publication gates

Review and commit genuine resolution evidence for `third-party/public-release.json`: original licenses, corresponding source archives and actual artifact inventories. Then update the distribution scope in `PUBLIC-SOURCE.json`. Do not simply clear pending items to make CI pass.

Client desktop acceptance requires six entries in `tools/ci/soduwork-acceptance-baselines.json`: `windows-x64-exe`, `linux-x64-deb`, `linux-x64-rpm`, `linux-x64-tar.gz`, `macos-arm64-dmg` and `macos-x64-dmg`. Each entry includes `productName: SoduWork`, a strictly older `version`, `sha256`, and a `url` pointing to the same public GitHub repository, with optional `format`/`size`. Local paths and internal fallback downloads are rejected. The first public binary release has no previous public baseline and needs a separately reviewed first-release acceptance contract. Never substitute the candidate for an older version to claim a successful upgrade. Android is checked independently through signed package identity and emulator installation; it does not reuse a desktop baseline.

Hub images are delivered as Release assets. After downloading and verifying the manifest, run `docker load --input <image.tar.gz>` and configure your environment using the [self-hosting guide](../ops/self-host/README.md). This workflow does not push to GHCR or migrate company cluster deployment, backup schedules, domains or update services.

## Local validation

```sh
python -m unittest discover -s tools/github -p 'test_*.py'
python -m unittest tools.dev.test_source_export tools.dev.test_deploy tools.security.test_scan_secrets
python tools/github/check_public_ci.py
node --test tools/check-public-source.test.cjs tools/source-manifest.test.cjs tools/check-docs.test.cjs
node tools/check-public-source.cjs
node tools/check-docs.cjs
actionlint .github/workflows/*.yml
```

Application source changes still require full regression checks for affected modules. Review and commit new files before exporting. Do not generate or commit a source manifest in a checkout. In an extracted exporter-produced ZIP, run `node tools/check-source-manifest.cjs` to verify the generated inventory. Public-source, secret and third-party checks remain independent of archive integrity.

Release procedures, workflow documentation and contribution templates are maintained in English.

References: [GitLab migration](https://docs.github.com/en/actions/tutorials/migrate-to-github-actions/manual-migrations/migrate-from-gitlab-cicd), [deployment environments](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments), [Actions limits](https://docs.github.com/en/actions/reference/limits).
