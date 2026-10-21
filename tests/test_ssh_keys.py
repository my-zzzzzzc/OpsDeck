"""SSH 私钥路径解析测试。"""

from app.config import settings
from app.ssh_keys import resolve_ssh_key


def test_override_dir_maps_by_basename(monkeypatch, tmp_path):
    key = tmp_path / "opsdeck_ed25519"
    key.write_text("test-key", encoding="utf-8")
    monkeypatch.setattr(settings, "ssh_key_override_dir", str(tmp_path))
    monkeypatch.setattr(settings, "ssh_default_key_path", "")

    assert resolve_ssh_key("/root/.ssh/opsdeck_ed25519") == str(key)


def test_override_dir_keeps_original_when_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "ssh_key_override_dir", str(tmp_path))
    monkeypatch.setattr(settings, "ssh_default_key_path", "")

    assert resolve_ssh_key("/root/.ssh/other_key") == "/root/.ssh/other_key"


def test_default_key_when_server_has_none(monkeypatch, tmp_path):
    key = tmp_path / "default_ed25519"
    key.write_text("test-key", encoding="utf-8")
    monkeypatch.setattr(settings, "ssh_key_override_dir", "")
    monkeypatch.setattr(settings, "ssh_default_key_path", str(key))

    assert resolve_ssh_key(None) == str(key)
    assert resolve_ssh_key("") == str(key)


def test_no_default_returns_none(monkeypatch):
    monkeypatch.setattr(settings, "ssh_key_override_dir", "")
    monkeypatch.setattr(settings, "ssh_default_key_path", "")

    assert resolve_ssh_key(None) is None
