"""Reproducibility manifest generation and input hashing for ElectionSimulator v1."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
from typing import Any

from .config import MODEL_VERSION


def get_git_commit_hash(repo_dir: Path | str | None = None) -> str:
    """Retrieve current Git commit SHA-256 or HEAD hash."""
    r_dir = Path(repo_dir) if repo_dir else Path(__file__).resolve().parents[2]
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=r_dir,
            capture_output=True,
            text=True,
            check=True,
        )
        return res.stdout.strip()
    except Exception:
        return "unknown_git_commit"


def compute_file_sha256(file_path: Path | str) -> str:
    """Compute SHA-256 checksum of a file on disk."""
    p = Path(file_path)
    if not p.exists():
        return "file_not_found"
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_dict_sha256(data_dict: dict[str, Any]) -> str:
    """Compute deterministic SHA-256 checksum of a dictionary."""
    encoded = json.dumps(data_dict, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_reproducibility_manifest(
    as_of: str,
    election_date: str,
    samples: int,
    base_seed: int,
    poll_data_path: Path | str | None = None,
    election_data_path: Path | str | None = None,
    mandate_data_path: Path | str | None = None,
    geography_data_path: Path | str | None = None,
    model_config: dict[str, Any] | None = None,
    repo_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Generate canonical reproducibility manifest for a simulation execution."""
    root_dir = Path(repo_dir) if repo_dir else Path(__file__).resolve().parents[2]
    
    p_poll = Path(poll_data_path) if poll_data_path else root_dir / "data" / "processed" / "pollofpolls" / "swedishpolls_individual_polls.csv"
    p_elec = Path(election_data_path) if election_data_path else root_dir / "data" / "processed" / "elections" / "riksdag_election_results.csv"
    p_mand = Path(mandate_data_path) if mandate_data_path else root_dir / "data" / "processed" / "mandates" / "historical_certified_mandates.csv"
    p_geog = Path(geography_data_path) if geography_data_path else root_dir / "data" / "processed" / "geography" / "constituency_party_votes_2014_2022.csv"

    cfg = model_config or {
        "opinion_model": "OpinionState_v1.1",
        "dynamics_model": "symmetric_all_history",
        "noise_model": "pp_centered_noise",
        "geography_model": "GeographicProjection_v1",
        "mandate_model": "MandateAllocator_v1",
    }

    manifest = {
        "model_version": MODEL_VERSION,
        "as_of": str(as_of),
        "election_date": str(election_date),
        "samples": int(samples),
        "base_seed": int(base_seed),
        "poll_data_hash": compute_file_sha256(p_poll),
        "election_data_hash": compute_file_sha256(p_elec),
        "mandate_data_hash": compute_file_sha256(p_mand),
        "geography_data_hash": compute_file_sha256(p_geog),
        "model_config_hash": compute_dict_sha256(cfg),
        "model_config": cfg,
        "git_commit": get_git_commit_hash(root_dir),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    return manifest


def compute_simulation_payload_sha256(
    national_matrix: Any,
    seats_matrix: Any,
    summary_dict: dict[str, Any],
) -> str:
    """Compute deterministic SHA-256 checksum over deterministic simulation payload."""
    import numpy as np
    h = hashlib.sha256()
    nat_arr = np.asarray(national_matrix, dtype=np.float64)
    seat_arr = np.asarray(seats_matrix, dtype=np.int64)
    h.update(nat_arr.tobytes())
    h.update(seat_arr.tobytes())
    # Deterministic summary serialization (excluding any timestamps)
    clean_summary = {k: v for k, v in summary_dict.items() if k not in ("generated_at_utc", "runtime_seconds")}
    summary_bytes = json.dumps(clean_summary, sort_keys=True, ensure_ascii=False).encode("utf-8")
    h.update(summary_bytes)
    return h.hexdigest()

