"""Loopback-only fixture for the production legal administration UI."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import zipfile


def import_documents(root):
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt
    copies = {
        'zh-CN': ('测试用户协议', '本协议说明服务使用规则和个人信息处理方式。我们仅收集提供服务所需的信息，用户可以查看、修改或删除自己的账户资料。'),
        'en-US': ('Fixture Terms', 'These terms explain the conditions for using this service. You retain your rights to your personal information. We collect only the information necessary to provide the service and protect your account.'),
        'ja-JP': ('利用規約', 'この利用規約はサービスを利用する際の条件を定めています。個人情報はサービスの提供に必要な範囲で処理されます。ユーザーは自分のアカウント情報を確認し、変更または削除できます。'),
        'ko-KR': ('이용약관', '이 이용약관은 서비스를 이용하는 조건을 설명합니다. 개인정보는 서비스 제공에 필요한 범위에서 처리됩니다. 사용자는 자신의 계정 정보를 확인하고 수정하거나 삭제할 수 있습니다.'),
    }
    files = {}
    for locale, (title, body) in copies.items():
        document = Document()
        language = OxmlElement('w:lang'); language.set(qn('w:val'), locale)
        document.styles['Normal'].element.get_or_add_rPr().append(language)
        document.add_heading(title, level=1)
        paragraph = document.add_paragraph(body)
        paragraph.paragraph_format.space_before = Pt(6)
        paragraph.paragraph_format.space_after = Pt(8)
        paragraph.paragraph_format.line_spacing = 1.5
        paragraph.paragraph_format.first_line_indent = Pt(22)
        items = {'zh-CN': ['原文第一项', '原文第二项'], 'en-US': ['First source item', 'Second source item'],
                 'ja-JP': ['原文の最初の項目', '原文の二番目の項目'], 'ko-KR': ['원문의 첫 번째 항목', '원문의 두 번째 항목']}
        for value in items[locale]: document.add_paragraph(value, style='List Number')
        table = document.add_table(rows=2, cols=2)
        for cell, value in zip([cell for row in table.rows for cell in row.cells], ['Item', 'Text', 'Account', 'Original']):
            cell.text = value
        target = root / f'legal-{locale}.docx'; document.save(target)
        files[locale] = str(target)
    (root / 'short.txt').write_text('Short text.', encoding='utf-8')
    (root / 'invalid.docx').write_text('Not a ZIP document.', encoding='utf-8')
    files['short'] = str(root / 'short.txt'); files['invalid'] = str(root / 'invalid.docx')
    (root / 'source.txt').write_text(copies['en-US'][1], encoding='utf-8')
    (root / 'source.md').write_text('# Original heading\n\n' + copies['en-US'][1] + '\n\n<img src="https://untrusted.test/pixel" onerror="window.importInjected=true">', encoding='utf-8')
    files['text'] = str(root / 'source.txt'); files['markdown'] = str(root / 'source.md')
    revision_file = root / 'revisions.docx'
    with zipfile.ZipFile(files['en-US']) as source, zipfile.ZipFile(revision_file, 'w', zipfile.ZIP_DEFLATED) as output:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == 'word/document.xml':
                data = data.replace(b'<w:body>', b'<w:body><w:ins w:id="1"><w:p><w:r><w:t>Unresolved amendment</w:t></w:r></w:p></w:ins>', 1)
            output.writestr(info.filename, data)
    files['revisions'] = str(revision_file)
    with zipfile.ZipFile(root / 'oversized.docx', 'w', zipfile.ZIP_DEFLATED) as output:
        output.writestr('word/document.xml', b' ' * (21 * 1024 * 1024))
        output.writestr('[Content_Types].xml', b'<Types/>')
    files['oversized'] = str(root / 'oversized.docx')
    empty = Document(); empty.add_paragraph(); empty.save(root / 'empty.docx')
    files['empty'] = str(root / 'empty.docx')
    return files


async def serve(root):
    import_files = import_documents(root)
    os.environ['DATABASE_URL'] = 'sqlite+aiosqlite:///' + (root / 'test.db').as_posix()
    os.environ['SODUWORK_DATA_ROOT'] = str(root / 'data')
    os.environ['AUTH_SECRET'] = 'legal-fixture-only-' + secrets.token_hex(32)
    os.environ['ADMIN_PASS'] = 'legal-fixture-only-' + secrets.token_hex(16)
    os.environ['CLUSTER_REDIS_URL'] = ''
    os.environ['SODUWORK_ENV'] = 'development'
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.config import Settings
    Settings.model_config['env_file'] = None
    import uvicorn
    from fastapi import Depends, FastAPI
    from app.api import account_profile, legal_documents
    from app.auth import sign_token
    from app.db import Base, engine, SessionLocal
    from app.deps import current_user
    from app.models import OrgUnit, User, Client
    from app.services.device_auth import issue_session
    from app.services.rbac import user_to_api

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add(OrgUnit(id='fixture-org', name='Isolated organization'))
        session.add(User(id='fixture-admin', username='fixture-admin', display_name='Legal fixture',
                         org_id='fixture-org', is_super=True, is_active=True))
        session.add(User(id='fixture-reader', username='fixture-reader', org_id='fixture-org', is_active=True))
        session.add(Client(id='fixture-device', user_ref='fixture-reader', auth_state='active'))
        await session.commit()
        device_token = issue_session(await session.get(Client, 'fixture-device'))[0]
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    token = sign_token('fixture-admin', ttl_hours=1)

    @asynccontextmanager
    async def lifespan(app):
        print(json.dumps({'ready': True, 'fixtureOnly': True, 'url': f'http://127.0.0.1:{port}',
                          'token': token, 'deviceToken': device_token, 'importFiles': import_files}), flush=True)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    for router in (account_profile.router, legal_documents.router, legal_documents.admin_router):
        app.include_router(router)

    @app.get('/healthz')
    async def health():
        return {'ok': True, 'version': 'fixture'}

    @app.get('/api/v1/admin/me')
    async def me(user=Depends(current_user)):
        return {**user_to_api(user), 'permissions': sorted(user._perms)}

    try:
        await uvicorn.Server(uvicorn.Config(app, log_level='warning')).serve(sockets=[sock])
    finally:
        sock.close()
        await engine.dispose()


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='soduwork-legal-fixture-') as directory:
        asyncio.run(serve(Path(directory)))
