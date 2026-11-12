"""Deterministic offline builds of the three reviewed official platform packs."""
from __future__ import annotations

import errno
import hashlib
import io
import json
import os
import tempfile
from pathlib import Path
import re
import zipfile

PLATFORMS = ('feishu', 'dingtalk', 'wecom')
SOURCES = Path(__file__).parent / 'plugins' / 'platforms'


def adapted(name: str, data: bytes) -> bytes:
    if name == 'skills/dingtalk-aitable/scripts/upload_attachment.py':
        text = data.decode('utf8')
        text = re.sub(r'(?m)^(\s*\w*[Tt]oken\s*)= (data\.get\([^\n]+)$',
                      lambda m: m[1] + '= (\n        ' + m[2] + '\n    )', text)
        updated = text.replace('Token: {json.dumps', 'Token response: {json.dumps').encode('utf8')
        notice = ('# Modified by SoduWork, 2026-10-17: token assignment formatting and '
                  'diagnostic label; runtime behavior unchanged. See ADAPTATIONS.md.\n').encode('utf8')
        # Keep a Python shebang and encoding cookie in their required positions.
        lines = updated.splitlines(keepends=True)
        position = 1 if lines and lines[0].startswith(b'#!') else 0
        if position < len(lines) and re.search(rb'coding[:=]\s*[-\w.]+', lines[position]):
            position += 1
        return b''.join(lines[:position]) + notice + b''.join(lines[position:])
    if name == 'skills/dingtalk-shared/references/recipes/conventions.md':
        notice = b'<!-- Modified by SoduWork, 2026-10-17: correct package-local Skill links; see ADAPTATIONS.md. -->\n'
        return notice + data.replace(b'(../../../SKILL.md)', b'(../../SKILL.md)')
    if name == 'skills/dingtalk-misc/references/dev/recipes.md':
        notice = b'<!-- Modified by SoduWork, 2026-10-17: reorder public sample query parameters and shorten a placeholder; see ADAPTATIONS.md. -->\n'
        return notice + data.replace(b'upload?access_token=<token>&type=image',
                                     b'upload?type=image&access_token=<t>').replace(b'<t>`', b'<t>` ')
    if name == 'skills/wecom-unified/SKILL.md':
        text = data.decode('utf8')
        text = re.sub(r'(?m)^description:.*$',
                      'description: "用户明确选择企业微信插件或请求操作企业微信业务时，按需读取对应业务域文档。"', text)
        start, end = text.index('## ⚠️ 前置检查'), text.index('## 获取个人身份')
        text = text[:start] + ('## SoduWork 运行准备\n\n先读取 ../wecom/SKILL.md 和 ../../README.md。'
                              '安装与登录独立进行；所有 CLI 命令经随包 runtime.mjs 使用本账号授权目录执行。\n\n') + text[end:]
        start, end = text.index('## 通用输出约束'), text.index('## 业务域概览')
        text = text[:start] + ('## 结果呈现\n\n优先展示名称和可读链接；用户明确需要资源 ID 时，'
                              '按实际权限提供必要标识。凭据不得输出。\n\n') + text[end:]
        return text.encode('utf8')
    return data


def package_bytes(provider: str, sources: Path = SOURCES) -> bytes:
    if provider not in PLATFORMS:
        raise ValueError('Unknown platform')
    folder = sources / provider
    lock = json.loads((folder / 'upstream-lock.json').read_text(encoding='utf8'))
    snapshot = (folder / 'upstream.zip').read_bytes()
    if hashlib.sha256(snapshot).hexdigest() != lock['snapshotSha256']:
        raise ValueError('Upstream snapshot checksum mismatch: ' + provider)
    files = {}
    with zipfile.ZipFile(io.BytesIO(snapshot)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(lock['upstreamFiles']):
            raise ValueError('Upstream inventory mismatch: ' + provider)
        for name in names:
            data = archive.read(name)
            if hashlib.sha256(data).hexdigest() != lock['upstreamFiles'][name]:
                raise ValueError('Upstream file checksum mismatch: ' + name)
            files[name] = adapted(name, data)
    adaptations = (sources / 'ADAPTATIONS.md').read_bytes()
    provider_adaptations = folder / 'ADAPTATIONS.md'
    if provider_adaptations.is_file():
        adaptations += b'\n' + provider_adaptations.read_bytes()
    files.update({
        'plugin.json': (folder / 'plugin.json').read_bytes(),
        'README.md': (folder / 'README.md').read_bytes(),
        'upstream-lock.json': (folder / 'upstream-lock.json').read_bytes(),
        'ADAPTATIONS.md': adaptations,
        'scripts/runtime.mjs': (sources / 'runtime.mjs').read_bytes(),
        f'skills/{provider}/SKILL.md': (folder / 'SKILL.md').read_bytes(),
    })
    if provider == 'dingtalk':
        files['scripts/prepare-dingtalk.py'] = (sources / 'prepare-dingtalk.py').read_bytes()
    for path in sorted((folder / 'examples').glob('*')):
        files['examples/' + path.name] = path.read_bytes()
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 9, 9, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    data = output.getvalue()
    # Exercise the actual import/runtime resource validator before publishing bytes.
    from app.services import plugin_packages
    plugin_packages.parse(data)
    return data


def _publish(path: Path, data: bytes) -> None:
    """Atomically publish a new immutable path without replacing another build."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('Changed package requires version bump: ' + str(path))
        return
    fd, pending = tempfile.mkstemp(prefix='.platform-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(pending, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError('Concurrent package version conflict: ' + str(path))
        except OSError as exc:
            if exc.errno not in (errno.EXDEV, errno.ENOSYS, errno.ENOTSUP) and getattr(exc, 'winerror', 0) != 17:
                raise
            # Protected Windows volumes can reject links even within one directory.
            # Exclusive creation never overwrites an accepted/concurrent package.
            try:
                with path.open('xb') as target:
                    target.write(data)
                    target.flush()
                    os.fsync(target.fileno())
            except FileExistsError:
                if path.read_bytes() != data:
                    raise ValueError('Concurrent package version conflict: ' + str(path))
            if path.read_bytes() != data:
                raise ValueError('Published package checksum mismatch: ' + str(path))
    finally:
        os.unlink(pending)


def build(output: Path | None = None) -> list[Path]:
    from app.services import plugin_packages
    output = output or SOURCES / 'releases'
    built = []
    # Validate every pack before publishing any candidate.
    packages = [(provider, package_bytes(provider)) for provider in PLATFORMS]
    for provider, data in packages:
        version = plugin_packages.parse(data)['manifest']['version']
        path = output / provider / (version + '.soduwork-plugin')
        # An extension change must not bypass the immutable version check.
        for suffix in ('.soduwork-plugin', '.soduwork-plugin'):
            legacy = path.with_suffix(suffix)
            if legacy.exists() and legacy.read_bytes() != data:
                raise ValueError('Changed package requires version bump: ' + str(legacy))
        _publish(path, data)
        built.append(path)
    return built


if __name__ == '__main__':
    for path in build():
        print(path.name, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
