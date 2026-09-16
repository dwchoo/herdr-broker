import json
import os
from tempfile import TemporaryDirectory

import pytest
from herdr_broker.herdr import BrokerError
from herdr_broker.sdk_runtime import analysis_profile
from herdr_broker.worker import MODEL


def test_profile_references_auth_preserves_metadata_and_never_changes_parent(sdk_home):
    source_cache = sdk_home / 'models_cache.json'
    original = json.loads(source_cache.read_text())
    original['models'][0].update(guardian={'shell': 'all'}, context_window=100000)
    source_cache.write_text(json.dumps(original))
    saved_cache = source_cache.read_bytes()
    saved_config = (sdk_home / 'config.toml').read_bytes()
    saved_env = os.environ.get('CODEX_HOME')
    with TemporaryDirectory() as directory:
        profile, catalog = analysis_profile(directory, MODEL)
        assert profile.stat().st_mode & 0o777 == 0o700
        assert (profile / 'auth.json').is_symlink()
        assert (profile / 'auth.json').resolve() == sdk_home / 'auth.json'
        # The pinned SDK refresh writes through the reference; no detached copy.
        (profile / 'auth.json').write_text('{"test_refresh": true}')
        assert (sdk_home / 'auth.json').read_text() == '{"test_refresh": true}'
        assert not (profile / 'AGENTS.md').exists() and not (profile / 'config.toml').exists()
        model = json.loads(catalog.read_text())['models'][0]
        restricted = {'tool_mode', 'apply_patch_tool_type', 'supports_search_tool',
                      'multi_agent_version', 'experimental_supported_tools'}
        assert {k: v for k, v in model.items() if k not in restricted} == {
            k: v for k, v in original['models'][0].items() if k not in restricted}
        assert model['tool_mode'] == 'direct' and model['apply_patch_tool_type'] is None
        assert model['supports_search_tool'] is False and model['multi_agent_version'] is None
    assert (sdk_home / 'auth.json').is_file()
    assert source_cache.read_bytes() == saved_cache
    assert (sdk_home / 'config.toml').read_bytes() == saved_config
    assert os.environ.get('CODEX_HOME') == saved_env


@pytest.mark.parametrize('bad_cache', [None, '{', '{}', '{"models":null}', '{"models":[]}', '{"models":[1]}'])
def test_missing_model_context_never_falls_back_to_user_profile(sdk_home, tmp_path, bad_cache):
    cache = sdk_home / 'models_cache.json'
    if bad_cache is None:
        cache.unlink()
    else:
        cache.write_text(bad_cache)
    with pytest.raises(BrokerError, match='worker_model_catalog_unavailable'):
        analysis_profile(str(tmp_path), MODEL)
    assert not (tmp_path / 'profile').exists()


def test_missing_file_auth_is_explicit(sdk_home, tmp_path):
    (sdk_home / 'auth.json').unlink()
    with pytest.raises(BrokerError, match='worker_auth_unavailable'):
        analysis_profile(str(tmp_path), MODEL)
    assert not (tmp_path / 'profile').exists()


@pytest.mark.parametrize('missing', ['auth.json', 'models_cache.json'])
async def test_prewarm_error_survives_until_public_read(harness, sdk_home, missing):
    from herdr_broker.worker import Worker
    from test_mcp import call

    (sdk_home / missing).unlink()
    _, broker, server, _ = harness
    worker = Worker()
    broker.worker = worker
    code = 'worker_auth_unavailable' if missing == 'auth.json' else 'worker_model_catalog_unavailable'
    try:
        worker.warmup()
        with pytest.raises(BrokerError, match=code):
            await worker.startup
        with pytest.raises(Exception, match=code):
            await server.call_tool('pane_read', {'pane_id': 'w1:p2', 'terminal_id': 'term_2'})
        assert (await call(server, 'pane_list'))['panes']
        assert (await call(server, 'pane_read', pane_id='w1:p2', terminal_id='term_2', raw=True))['kind'] == 'raw'
    finally:
        await worker.close()


def test_resource_bytes_do_not_follow_external_runtime_symlinks(tmp_path):
    from types import SimpleNamespace

    from herdr_broker.sdk_runtime import SDKRuntime
    source = tmp_path / 'installed-runtime'
    source.write_bytes(b'x' * 1024)
    owned = tmp_path / 'worker'
    owned.mkdir()
    (owned / 'actual').write_bytes(b'123')
    (owned / 'wrapper').symlink_to(source)
    runtime = SDKRuntime(SimpleNamespace(), str(owned), lambda: None)
    assert runtime.resources() == {'rss_bytes': None, 'temporary_bytes': 3}
