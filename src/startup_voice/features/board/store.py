"""Storage and rules for publicly shared dossiers (the Idea Board).

Design, in short (details and the data-protection checklist: docs/ido-journey/PUBLIC_SHARING.md):

* PRIVATE BY DEFAULT. Nothing is public until the founder publishes, with explicit consent.
* A SNAPSHOT: the text is copied at publish time. Later edits of the dossier never leak.
* ONLY product / traction / market / financing. ``team`` (names and backgrounds, often of people who
  never agreed) is rejected here, whatever a client sends.
* LISTING is a second, separate consent: without it the page is reachable only by its link.
* NO ACCOUNT, so ownership is a secret OWNER KEY: shown once at publish time, only its SHA-256 hash is
  stored, and it is the only way to update or withdraw. An e-mail address is optional, stored only with
  consent, and never published.
* WITHDRAWING DELETES the text, the title and the e-mail; the slug, the consent record and the
  withdrawal time stay (the link stays dead; consent can be demonstrated).
* No IP addresses or user agents are stored anywhere in this module.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PUBLISHABLE = ("product", "traction", "market", "financing")
MAX_TITLE = 80
MAX_SECTION = 3000
MAX_TOTAL = 10000
MAX_EMAIL = 254
MAX_REPORT = 500
EXCERPT_CHARS = 160
SLUG_RE = re.compile(r"^[0-9a-f]{16}$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,24}$")

#: Bump whenever the consent wording in the UI changes; stored with every publication.
CONSENT_VERSION = "draft-2026-11-19"


class PublishError(ValueError):
    """A rule was violated; the message is safe to show to the founder."""


class OwnerKeyError(PermissionError):
    """Missing or wrong owner key."""


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def new_owner_key() -> str:
    return "ik_" + secrets.token_urlsafe(24)


def validate_publication(title: str, sections: dict[str, Any]) -> tuple[str, dict[str, str]]:
    """Returns the cleaned title and sections, or raises PublishError. Pure."""
    clean_title = " ".join(str(title or "").split())
    if not clean_title:
        raise PublishError("A title is required.")
    if len(clean_title) > MAX_TITLE:
        raise PublishError(f"The title is too long (max {MAX_TITLE} characters).")
    if not isinstance(sections, dict):
        raise PublishError("Sections must be a mapping.")
    clean: dict[str, str] = {}
    total = 0
    for key in PUBLISHABLE:  # fixed order
        if key not in sections:
            continue
        value = sections[key]
        if not isinstance(value, str):
            raise PublishError(f"Section {key} must be text.")
        text = value.strip()
        if not text:
            continue
        if len(text) > MAX_SECTION:
            raise PublishError(f"Section {key} is too long (max {MAX_SECTION} characters).")
        total += len(text)
        clean[key] = text
    for key in sections:
        if key == "team":
            raise PublishError("The team section is never published.")
        if key not in PUBLISHABLE:
            raise PublishError(f"Unknown section: {str(key)[:40]}")
    if not clean:
        raise PublishError("Select at least one section with text.")
    if total > MAX_TOTAL:
        raise PublishError("Too much text.")
    return clean_title, clean


def validate_email(email: str | None) -> str | None:
    if email is None or not str(email).strip():
        return None
    value = str(email).strip()
    if len(value) > MAX_EMAIL or not _EMAIL_RE.match(value):
        raise PublishError("That e-mail address does not look valid.")
    return value


def excerpt(sections: dict[str, str]) -> str:
    for key in PUBLISHABLE:
        text = sections.get(key)
        if text:
            flat = " ".join(text.split())
            return flat if len(flat) <= EXCERPT_CHARS else flat[: EXCERPT_CHARS - 1].rstrip() + "…"
    return ""


@dataclass
class Published:
    slug: str
    owner_key: str | None  # only set when the record was just created


class RateLimiter:
    """In-memory sliding window per caller. Nothing is persisted, so no personal data is kept."""

    def __init__(self, limit: int, window_s: int) -> None:
        self.limit, self.window_s = limit, window_s
        self._hits: dict[str, list[float]] = {}

    def allow(self, who: str, *, now: float | None = None) -> bool:
        t = time.monotonic() if now is None else now
        hits = [h for h in self._hits.get(who, []) if t - h < self.window_s]
        if len(hits) >= self.limit:
            self._hits[who] = hits
            return False
        hits.append(t)
        self._hits[who] = hits
        return True


class BoardStore:
    def __init__(self, root: Path) -> None:
        self.dir = Path(root) / "public"

    # -- files ----------------------------------------------------------------------------------
    def _path(self, slug: str) -> Path:
        if not SLUG_RE.match(slug):
            raise KeyError(slug)
        return self.dir / f"{slug}.json"

    def _read(self, slug: str) -> dict | None:
        try:
            return json.loads(self._path(slug).read_text(encoding="utf-8"))
        except (KeyError, FileNotFoundError, ValueError):
            return None

    def _write(self, rec: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self._path(rec["slug"])
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)

    def _all(self) -> list[dict]:
        if not self.dir.is_dir():
            return []
        out = []
        for p in sorted(self.dir.glob("*.json")):
            try:
                out.append(json.loads(p.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return out

    def for_session(self, session_id: str) -> dict | None:
        return next((r for r in self._all() if r.get("session_id") == session_id), None)

    # -- publish / update -----------------------------------------------------------------------
    def publish(
        self,
        *,
        session_id: str,
        title: str,
        sections: dict[str, Any],
        listed: bool,
        consent: bool,
        listing_consent: bool,
        consent_version: str,
        email: str | None,
        email_consent: bool,
        owner_key: str | None,
    ) -> Published:
        if not consent:
            raise PublishError("Consent to publish is required.")
        if listed and not listing_consent:
            raise PublishError("Consent to being listed on the board is required.")
        if not consent_version or len(consent_version) > 64:
            raise PublishError("A consent version is required.")
        clean_title, clean = validate_publication(title, sections)
        clean_email = validate_email(email)
        if clean_email and not email_consent:
            raise PublishError("Consent to store the e-mail address is required.")

        existing = self.for_session(session_id)
        if existing is not None:
            if not owner_key or not hmac.compare_digest(hash_key(owner_key), existing["owner_key_hash"]):
                raise OwnerKeyError("The owner key is required to update this publication.")
            existing.update(
                title=clean_title,
                sections=clean,
                listed=bool(listed),
                consent_version=consent_version,
                consent_at=now_iso(),
                published_at=now_iso(),
                unpublished_at=None,
                email=clean_email if email_consent else None,
            )
            self._write(existing)
            return Published(existing["slug"], None)

        key = new_owner_key()
        slug = secrets.token_hex(8)
        self._write(
            {
                "slug": slug,
                "session_id": session_id,
                "title": clean_title,
                "sections": clean,
                "listed": bool(listed),
                "consent_version": consent_version,
                "consent_at": now_iso(),
                "published_at": now_iso(),
                "unpublished_at": None,
                "owner_key_hash": hash_key(key),
                "email": clean_email if email_consent else None,
            }
        )
        return Published(slug, key)

    # -- read -----------------------------------------------------------------------------------
    def public_view(self, slug: str) -> dict | None:
        rec = self._read(slug)
        if rec is None or rec.get("unpublished_at"):
            return None
        return {
            "slug": rec["slug"],
            "title": rec["title"],
            "sections": rec["sections"],
            "published_at": rec["published_at"],
        }

    def listed(self) -> list[dict]:
        items = [
            {
                "slug": r["slug"],
                "title": r["title"],
                "excerpt": excerpt(r["sections"]),
                "sections": [k for k in PUBLISHABLE if k in r["sections"]],
                "published_at": r["published_at"],
            }
            for r in self._all()
            if r.get("listed") and not r.get("unpublished_at")
        ]
        return sorted(items, key=lambda i: i["published_at"], reverse=True)

    # -- withdraw / report ----------------------------------------------------------------------
    def withdraw(self, slug: str, owner_key: str) -> bool:
        rec = self._read(slug)
        if rec is None:
            return False
        if not owner_key or not hmac.compare_digest(hash_key(owner_key), rec["owner_key_hash"]):
            raise OwnerKeyError("Wrong owner key.")
        rec.update(title="", sections={}, listed=False, email=None, unpublished_at=now_iso())
        self._write(rec)
        return True

    def report(self, slug: str, reason: str) -> bool:
        if self._read(slug) is None:
            return False
        self.dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"slug": slug, "reason": reason[:MAX_REPORT], "at": now_iso()}, ensure_ascii=False)
        with (self.dir / "reports.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
        return True
