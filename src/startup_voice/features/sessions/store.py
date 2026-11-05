"""Per-session artifact tree on disk (persistence only; scoring lives in scoring.py)."""

from __future__ import annotations

from datetime import UTC, datetime
import json
import shutil
from pathlib import Path

from startup_voice.domain import (
    DimensionState,
    DossierVersion,
    InterviewSession,
    StepEvaluation,
    StepSnapshot,
)
from startup_voice.features.dossier import render_dossier_markdown, render_dossier_pdf
from startup_voice.features.dossier.scoring import evaluate_session


def evaluate_artifact_file(path: Path) -> StepEvaluation:
    """Score a single objects/*.json, steps/*.json, or session.json offline."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if "objects_state" in data:
        session = InterviewSession(
            id="eval",
            objects={k: DimensionState.model_validate(v) for k, v in data["objects_state"].items()},
        )
        return evaluate_session(session)
    if "objects" in data and isinstance(data["objects"], dict):
        return evaluate_session(InterviewSession.model_validate(data))
    if "slot" in data:
        state = DimensionState.model_validate(data)
        session = InterviewSession.create()
        session.objects[state.slot] = state
        return evaluate_session(session)
    raise ValueError(f"Unrecognized artifact: {path}")


class FileSessionStore:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def session_dir(self, session_id: str) -> Path:
        path = self.root / session_id
        path.mkdir(parents=True, exist_ok=True)
        (path / "objects").mkdir(exist_ok=True)
        (path / "steps").mkdir(exist_ok=True)
        (path / "dossiers").mkdir(exist_ok=True)
        return path

    def save_dossier_version(self, session: InterviewSession) -> DossierVersion:
        """Write an immutable timestamped dossier snapshot under dossiers/vXX_<ts>_dossier.*."""
        base = self.session_dir(session.id)
        dossiers_dir = base / "dossiers"
        next_v = len(session.dossier_versions) + 1
        now = datetime.now(UTC)
        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        vid = f"v{next_v:02d}_{stamp}"
        entry = DossierVersion(
            version=next_v,
            id=vid,
            created_at=now.isoformat(),
            turn_index=session.turn_index,
            field_coverage=float(session.evaluation.field_coverage or 0.0),
            evidence_specificity=float(session.evaluation.evidence_specificity or 0.0),
            ready_for_closing=bool(session.evaluation.ready_for_closing),
            spoken_summary=session.spoken_summary or "",
        )
        session.dossier_versions.append(entry)
        md = render_dossier_markdown(session)
        (dossiers_dir / f"{vid}_dossier.md").write_text(md, encoding="utf-8")
        (dossiers_dir / f"{vid}_dossier.json").write_text(
            session.model_dump_json(indent=2), encoding="utf-8"
        )
        try:
            pdf_bytes = render_dossier_pdf(session)
            (dossiers_dir / f"{vid}_dossier.pdf").write_bytes(pdf_bytes)
        except Exception:
            pass  # font/PDF optional on headless CI; md + json always written
        return entry

    def save(self, session: InterviewSession, *, step: StepSnapshot | None = None) -> Path:
        # Caller refreshes evaluation after dossier mutations (scoring.refresh_evaluation).
        # Do not re-score here — that double-ran evaluate_session on every turn.
        base = self.session_dir(session.id)
        (base / "session.json").write_text(
            session.model_dump_json(indent=2), encoding="utf-8"
        )
        for slot, state in session.objects.items():
            (base / "objects" / f"{slot}.json").write_text(
                state.model_dump_json(indent=2), encoding="utf-8"
            )
        (base / "evaluation.json").write_text(
            session.evaluation.model_dump_json(indent=2), encoding="utf-8"
        )
        (base / "dossier.md").write_text(render_dossier_markdown(session), encoding="utf-8")
        if step is not None:
            step_path = base / "steps" / f"turn_{step.turn_index:02d}.json"
            step_path.write_text(step.model_dump_json(indent=2), encoding="utf-8")
            eval_path = base / "steps" / f"turn_{step.turn_index:02d}_eval.json"
            eval_path.write_text(step.step_eval.model_dump_json(indent=2), encoding="utf-8")
        return base

    def load(self, session_id: str) -> InterviewSession:
        path = self.session_dir(session_id) / "session.json"
        return InterviewSession.model_validate_json(path.read_text(encoding="utf-8"))

    def list_ids(self) -> list[str]:
        return sorted(p.name for p in self.root.iterdir() if p.is_dir())

    def delete(self, session_id: str) -> None:
        path = self.root / session_id
        if not path.is_dir():
            raise FileNotFoundError(session_id)
        shutil.rmtree(path)

    def list_meta(self) -> list[dict]:
        items: list[dict] = []
        for sid in self.list_ids():
            path = self.root / sid / "session.json"
            if not path.is_file():
                continue
            try:
                s = InterviewSession.model_validate_json(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            preview = next((m.content[:72] for m in reversed(s.messages) if m.role == "user"), "")
            ev = s.evaluation
            complete = bool(s.finalized and ev.ready_for_closing)
            items.append({
                "id": s.id,
                "created_at": s.created_at,
                "turn_index": s.turn_index,
                "finalized": s.finalized,
                "ready_for_closing": ev.ready_for_closing,
                "complete": complete,
                "field_coverage": float(ev.field_coverage or 0),
                "preview": preview or "—",
            })
        return list(reversed(items))
