import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from importlib.resources import files
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from herdr_broker import cli
from herdr_broker.herdr import BrokerError
from herdr_broker.skills import setup


def test_setup_preserves_config_and_repeated_install(tmp_path):
    config = tmp_path / '.codex/config.toml'
    config.parent.mkdir()
    original = b'approval_policy="never"\n[mcp_servers.herdr_broker]\ncommand="custom"\n'
    config.write_bytes(original)
    result = setup(tmp_path)
    path = Path(result['skill_path'])
    assert result['changed'] and not path.is_symlink()
    assert path.read_bytes() == files('herdr_broker').joinpath('resources/broker.md').read_bytes()
    assert not setup(tmp_path)['changed']
    assert config.read_bytes() == original
    path.write_text('user-edited skill')
    with pytest.raises(BrokerError, match='skill_install_conflict') as exc:
        setup(tmp_path)
    assert str(path) in str(exc.value) and 'differs' in str(exc.value)
    assert path.read_text() == 'user-edited skill'
    assert list(path.parent.iterdir()) == [path]


@pytest.mark.parametrize('part', ['.agents', '.agents/skills', '.agents/skills/broker',
                                  '.agents/skills/broker/SKILL.md'])
def test_setup_preserves_symlinks(tmp_path, part):
    target = tmp_path / 'outside'
    target.mkdir()
    path = tmp_path / part
    path.parent.mkdir(parents=True, exist_ok=True)
    path.symlink_to(target)
    with pytest.raises(BrokerError, match='symlink'):
        setup(tmp_path)
    assert path.is_symlink() and list(target.iterdir()) == []


def test_setup_concurrent_publication(tmp_path):
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(setup, [tmp_path] * 16))
    assert sum(result['changed'] for result in results) == 1
    path = Path(results[0]['skill_path'])
    assert list(path.parent.iterdir()) == [path]


def test_setup_without_auth_or_herdr(tmp_path):
    env = dict(os.environ, HERDR_ENV='invalid', CODEX_HOME=str(tmp_path / 'no-auth'))
    result = subprocess.run([sys.executable, '-m', 'herdr_broker', 'setup'],
                            cwd=tmp_path, env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['changed']
    assert not (tmp_path / '.codex').exists()


@pytest.mark.parametrize('flag', ['--project', '--source', '--analysis-model', '--fast-mode'])
def test_old_setup_flags_rejected_before_writing(tmp_path, flag):
    result = subprocess.run([sys.executable, '-m', 'herdr_broker', 'setup', flag, 'old'],
                            cwd=tmp_path, capture_output=True, text=True)
    assert result.returncode == 2
    assert 'config.toml' in result.stderr and '--directory' in result.stderr
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize('legacy', [False, True])
def test_runtime_template_base_and_deprecation(tmp_path, monkeypatch, capsys, legacy):
    monkeypatch.chdir(tmp_path)
    base = tmp_path / 'old' if legacy else tmp_path
    directory = base / 'templates'
    directory.mkdir(parents=True)
    from herdr_broker.options import export_templates
    export_templates(directory)
    args = ['herdr-broker', 'mcp', '--template-dir', 'templates']
    if legacy:
        args += ['--project', str(base)]
    monkeypatch.setattr(sys, 'argv', args)
    serve = AsyncMock()
    monkeypatch.setattr(cli, 'serve', serve)
    cli.main()
    assert serve.call_args.args[0].template_dir == directory
    assert ('deprecated' in capsys.readouterr().err) == legacy


def test_setup_directory_and_repository_skill_match(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['herdr-broker', 'setup', '--directory', str(tmp_path)])
    cli.main()
    content = (tmp_path / '.agents/skills/broker/SKILL.md').read_bytes()
    root = Path(__file__).resolve().parents[1]
    assert content == (root / '.agents/skills/broker/SKILL.md').read_bytes()
    assert b'../../../' not in content


def test_runtime_check_needs_no_project(monkeypatch, capsys):
    from types import SimpleNamespace
    load = AsyncMock(return_value=SimpleNamespace(caller=None, workspace=None))
    monkeypatch.setattr(cli.Context, 'load', load)
    monkeypatch.setattr(sys, 'argv', ['herdr-broker', 'check'])
    cli.main()
    load.assert_awaited_once_with()
    assert json.loads(capsys.readouterr().out)['ok']
