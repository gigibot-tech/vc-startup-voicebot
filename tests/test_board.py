"""Public Idea Board: publishing rules, owner key, listing, withdrawal, headers. No network."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from startup_voice.features.board.store import (
    CONSENT_VERSION,
    BoardStore,
    OwnerKeyError,
    PublishError,
    RateLimiter,
    excerpt,
    hash_key,
    validate_email,
    validate_publication,
)
from startup_voice.web import create_app

OK = dict(
    listed=False, consent=True, listing_consent=False, consent_version=CONSENT_VERSION,
    email=None, email_consent=False, owner_key=None,
)


def publish(store, session="s1", title="Meine Idee", sections=None, **over):
    args = {**OK, **over}
    return store.publish(session_id=session, title=title, sections=sections or {"market": "B2B SaaS"}, **args)


# ---------- pure rules --------------------------------------------------------------------------
def test_team_is_rejected_whatever_else_is_sent():
    with pytest.raises(PublishError, match="never published"):
        validate_publication("T", {"team": "Anna"})
    with pytest.raises(PublishError, match="never published"):
        validate_publication("T", {"market": "ok", "team": "Anna"})


def test_unknown_empty_overlong_and_non_text_sections_are_rejected():
    for sections in ({"revenue": "x"}, {"market": "   "}, {"market": "x" * 3001}, {"market": 5}, {}, "market"):
        with pytest.raises(PublishError):
            validate_publication("T", sections)
    with pytest.raises(PublishError):
        validate_publication("T", {k: "x" * 2999 for k in ("product", "traction", "market", "financing")})


def test_title_rules_and_whitespace_are_normalised():
    assert validate_publication("  Eine   Idee ", {"market": " a "}) == ("Eine Idee", {"market": "a"})
    for bad in ("", "   ", "x" * 81):
        with pytest.raises(PublishError):
            validate_publication(bad, {"market": "a"})


def test_sections_keep_a_fixed_order():
    _, clean = validate_publication("T", {"financing": "f", "product": "p", "market": "m"})
    assert list(clean) == ["product", "market", "financing"]


def test_email_validation():
    assert validate_email(None) is None and validate_email("  ") is None
    assert validate_email(" a@b.de ") == "a@b.de"
    for bad in ("nope", "a@b", "a b@c.de", "x" * 300 + "@b.de"):
        with pytest.raises(PublishError):
            validate_email(bad)


def test_excerpt_is_short_flat_and_prefers_product():
    assert excerpt({"market": "m", "product": "Zeile 1\n\nZeile 2"}) == "Zeile 1 Zeile 2"
    assert len(excerpt({"market": "x" * 500})) == 160 and excerpt({"market": "x" * 500}).endswith("…")
    assert excerpt({}) == ""


def test_rate_limiter_window():
    r = RateLimiter(limit=2, window_s=10)
    assert r.allow("a", now=0) and r.allow("a", now=1) and not r.allow("a", now=2)
    assert r.allow("b", now=2)
    assert r.allow("a", now=11.5)  # the window moved on


# ---------- store: consent, key, listing, withdrawal ------------------------------------------
def test_consent_is_required_and_listing_needs_its_own(tmp_path):
    s = BoardStore(tmp_path)
    with pytest.raises(PublishError, match="Consent to publish"):
        publish(s, consent=False)
    with pytest.raises(PublishError, match="listed"):
        publish(s, listed=True, listing_consent=False)
    with pytest.raises(PublishError, match="e-mail"):
        publish(s, email="a@b.de", email_consent=False)
    assert list(s.dir.glob("*.json")) == [] if s.dir.exists() else True  # nothing written on refusal


def test_first_publish_returns_the_key_once_and_stores_only_its_hash(tmp_path):
    s = BoardStore(tmp_path)
    p = publish(s)
    assert p.owner_key and p.owner_key.startswith("ik_") and len(p.slug) == 16
    raw = (s.dir / f"{p.slug}.json").read_text()
    assert p.owner_key not in raw and hash_key(p.owner_key) in raw


def test_update_needs_the_owner_key_and_keeps_the_link(tmp_path):
    s = BoardStore(tmp_path)
    first = publish(s)
    with pytest.raises(OwnerKeyError):
        publish(s, sections={"market": "neu"})
    with pytest.raises(OwnerKeyError):
        publish(s, sections={"market": "neu"}, owner_key="ik_wrong")
    again = publish(s, sections={"market": "neu"}, owner_key=first.owner_key)
    assert again.slug == first.slug and again.owner_key is None
    assert s.public_view(first.slug)["sections"] == {"market": "neu"}


def test_unlisted_is_reachable_by_link_but_not_on_the_board(tmp_path):
    s = BoardStore(tmp_path)
    p = publish(s)
    assert s.public_view(p.slug) and s.listed() == []


def test_listed_appears_newest_first_with_excerpt_and_section_chips(tmp_path):
    s = BoardStore(tmp_path)
    publish(s, session="a", title="Alt", listed=True, listing_consent=True)
    publish(s, session="b", title="Neu", sections={"product": "App für X", "market": "M"}, listed=True, listing_consent=True)
    items = s.listed()
    assert [i["title"] for i in items] == ["Neu", "Alt"]
    assert items[0]["excerpt"] == "App für X" and items[0]["sections"] == ["product", "market"]
    assert set(items[0]) == {"slug", "title", "excerpt", "sections", "published_at"}  # nothing else leaks


def test_withdrawal_deletes_text_title_and_email_but_keeps_the_consent_record(tmp_path):
    s = BoardStore(tmp_path)
    p = publish(s, listed=True, listing_consent=True, email="a@b.de", email_consent=True)
    with pytest.raises(OwnerKeyError):
        s.withdraw(p.slug, "ik_wrong")
    assert s.public_view(p.slug) is not None  # wrong key changed nothing
    assert s.withdraw(p.slug, p.owner_key) is True
    rec = json.loads((s.dir / f"{p.slug}.json").read_text())
    assert rec["sections"] == {} and rec["title"] == "" and rec["email"] is None
    assert rec["consent_version"] == CONSENT_VERSION and rec["unpublished_at"]
    assert s.public_view(p.slug) is None and s.listed() == []


def test_republish_after_withdrawal_revives_the_same_link(tmp_path):
    s = BoardStore(tmp_path)
    p = publish(s)
    s.withdraw(p.slug, p.owner_key)
    q = publish(s, owner_key=p.owner_key, sections={"market": "wieder da"})
    assert q.slug == p.slug and s.public_view(p.slug)["sections"] == {"market": "wieder da"}


def test_email_is_only_kept_with_consent_and_never_in_public_views(tmp_path):
    s = BoardStore(tmp_path)
    p = publish(s, listed=True, listing_consent=True, email="a@b.de", email_consent=True)
    assert "a@b.de" not in json.dumps(s.public_view(p.slug)) + json.dumps(s.listed())


def test_slugs_that_are_not_ours_never_touch_the_disk(tmp_path):
    s = BoardStore(tmp_path)
    for bad in ("../x", "abc", "G" * 16, "..%2f..%2fetc%2fpasswd"):
        assert s.public_view(bad) is None
        assert s.withdraw(bad, "k") is False
        assert s.report(bad, "x") is False


# ---------- HTTP ------------------------------------------------------------------------------
class StubLLM:
    def complete(self, *a, **k):
        return "{}"


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("BOARD_INDEXABLE", raising=False)
    app = create_app(llm=StubLLM())
    return TestClient(app)


def seeded(client) -> str:
    sid = client.post("/api/sessions").json()["session"]["id"]
    s = client.app.state.sessions[sid]
    s.objects["market"].fields["target_icp"] = "Gründerinnen"
    s.objects["team"].fields["founders_roles"] = "Anna (CEO)"
    return sid


BODY = dict(title="Idee", sections={"market": "Zielgruppe: Gründerinnen"}, consent=True, consent_version=CONSENT_VERSION)


def test_preview_offers_only_publishable_sections(client):
    sid = seeded(client)
    prev = client.get(f"/api/sessions/{sid}/publish-preview").json()
    assert set(prev["sections"]) == {"market"} and prev["existing"] is None  # team is never offered


def test_http_publish_then_public_read_and_board(client):
    sid = seeded(client)
    r = client.post(f"/api/sessions/{sid}/publish", json={**BODY, "listed": True, "listing_consent": True})
    assert r.status_code == 200 and r.json()["owner_key"].startswith("ik_")
    slug = r.json()["slug"]
    assert client.get(f"/api/public/{slug}").json()["sections"] == {"market": "Zielgruppe: Gründerinnen"}
    assert [i["slug"] for i in client.get("/api/public/board").json()["items"]] == [slug]
    assert client.get(f"/d/{slug}").status_code == 200 and client.get("/board").status_code == 200


def test_http_rules_refuse_team_missing_consent_and_unknown_sessions(client):
    sid = seeded(client)
    assert client.post(f"/api/sessions/{sid}/publish", json={**BODY, "sections": {"team": "Anna"}}).status_code == 422
    assert client.post(f"/api/sessions/{sid}/publish", json={**BODY, "consent": False}).status_code == 422
    assert client.post("/api/sessions/nope/publish", json=BODY).status_code == 404
    assert client.get("/api/public/board").json()["items"] == []


def test_http_update_and_withdraw_need_the_key(client):
    sid = seeded(client)
    first = client.post(f"/api/sessions/{sid}/publish", json=BODY).json()
    assert client.post(f"/api/sessions/{sid}/publish", json=BODY).status_code == 403
    assert client.post(f"/api/public/{first['slug']}/withdraw", json={"owner_key": "ik_wrong"}).status_code == 403
    assert client.get(f"/api/public/{first['slug']}").status_code == 200
    assert client.post(f"/api/public/{first['slug']}/withdraw", json={"owner_key": first["owner_key"]}).status_code == 200
    assert client.get(f"/api/public/{first['slug']}").status_code == 404


def test_http_report_is_recorded_without_reporter_data(client, tmp_path):
    sid = seeded(client)
    slug = client.post(f"/api/sessions/{sid}/publish", json=BODY).json()["slug"]
    assert client.post(f"/api/public/{slug}/report", json={"reason": "spam"}).status_code == 200
    assert client.post("/api/public/aaaaaaaaaaaaaaaa/report", json={"reason": "x"}).status_code == 404
    line = json.loads((tmp_path / "public" / "reports.jsonl").read_text().splitlines()[0])
    assert set(line) == {"slug", "reason", "at"}


def test_http_publish_is_rate_limited(client):
    sid = seeded(client)
    codes = [client.post(f"/api/sessions/{sid}/publish", json={**BODY, "consent": False}).status_code for _ in range(12)]
    assert codes[:10] == [422] * 10 and codes[10:] == [429, 429]


def test_public_pages_are_noindex_nosniff_and_unreferred_unless_the_operator_opts_in(client, monkeypatch):
    for path in ("/board", "/api/public/board"):
        h = client.get(path).headers
        assert h["x-robots-tag"] == "noindex, nofollow" and h["x-content-type-options"] == "nosniff"
        assert h["referrer-policy"] == "no-referrer" and h["content-security-policy"] == "frame-ancestors 'self'"
    monkeypatch.setenv("BOARD_INDEXABLE", "1")
    assert "x-robots-tag" not in client.get("/board").headers
    assert "x-robots-tag" not in client.get("/health").headers


def test_bad_slugs_are_404_on_pages_and_api(client):
    for path in ("/d/not-a-slug", "/api/public/not-a-slug", "/d/" + "g" * 16):
        assert client.get(path).status_code == 404


def test_public_javascript_never_writes_author_text_with_innerhtml():
    ui = Path(__file__).parent.parent / "src" / "startup_voice" / "features" / "board" / "ui"
    for name in ("board-page.js", "dossier-page.js", "publish.js", "home-board.js"):
        src = (ui / name).read_text(encoding="utf-8")
        assert "innerHTML" not in src and "insertAdjacentHTML" not in src and "document.write" not in src, name
    for name in ("board.html", "dossier.html"):
        html = (ui / name).read_text(encoding="utf-8")
        assert "fonts.googleapis" not in html and "<script>" not in html  # no third-party font, no inline script
