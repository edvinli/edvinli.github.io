"""End-to-end reproducible Swedish Riksdag ElectionSimulator v1."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Sequence
import numpy as np
import pandas as pd

from scripts.geography.config import (
    DEFAULT_PROCESSED_GEOGRAPHY_DIR,
    OFFICIAL_CONSTITUENCY_CODES,
)
from scripts.geography.integerization import biproportional_controlled_rounding
from scripts.geography.projection import _get_cached_geography_structures
from scripts.mandates.config import FIXED_SEATS_2018, FIXED_SEATS_2022, FIXED_SEATS_2026
from scripts.vote_share_calibration.national_engine import generate_national_vote_shares

from .config import (
    DEFAULT_ELECTION_DATE,
    DEFAULT_GEOGRAPHY_BASELINE_YEAR,
    DEFAULT_MAJORITY_THRESHOLD,
    DEFAULT_SIMULATION_SAMPLES,
    DEFAULT_SIMULATION_SEED,
    MODEL_PARTIES_9,
    PARLIAMENTARY_PARTIES_8,
)
from .fast_allocator import fast_allocate_seats_from_matrix
from .reproducibility import build_reproducibility_manifest
from .summary import GroupSummary, GroupSummaryHelper, SimulationSummary, compute_simulation_summary


@dataclass(frozen=True)
class SimulationResult:
    """Complete output of an ElectionSimulator run containing per-sample data and summary stats."""

    summary: SimulationSummary
    vote_shares_matrix: np.ndarray  # shape (N, 9), in percent [0, 100]
    seats_matrix: np.ndarray        # shape (N, 8), integer seats for parliamentary parties
    threshold_flags: np.ndarray     # shape (N, 8), boolean flags (vote share >= 4.0%)
    largest_vote_parties: list[str] # length N
    largest_seat_parties: list[str] # length N
    group_helper: GroupSummaryHelper
    manifest: dict[str, Any]

    def summarize_group(
        self,
        parties: Sequence[str],
        majority_threshold: int = DEFAULT_MAJORITY_THRESHOLD,
    ) -> GroupSummary:
        """Compute coalition / bloc summary for specified list of parties."""
        return self.group_helper.summarize_group(parties, majority_threshold=majority_threshold)

    def to_dataframe(self, max_rows: int | None = None) -> pd.DataFrame:
        """Convert per-sample simulations to pandas DataFrame."""
        n = len(self.seats_matrix) if max_rows is None else min(len(self.seats_matrix), max_rows)
        records = []
        for i in range(n):
            row = {"sample_id": i + 1}
            for p_idx, p in enumerate(MODEL_PARTIES_9):
                row[f"vote_{p}"] = float(self.vote_shares_matrix[i, p_idx])
            for p_idx, p in enumerate(PARLIAMENTARY_PARTIES_8):
                row[f"seats_{p}"] = int(self.seats_matrix[i, p_idx])
                row[f"{p}_above_4"] = bool(self.threshold_flags[i, p_idx])
            row["largest_vote_party"] = self.largest_vote_parties[i]
            row["largest_seat_party"] = self.largest_seat_parties[i]
            records.append(row)
        return pd.DataFrame(records)


def _apportion_constituency_units_of_25(R_continuous: np.ndarray, total_national_votes: int) -> np.ndarray:
    """Apportion national valid votes into constituency totals that are strictly multiples of 25.

    Ensures exact representation of 12.0% (3/25) threshold at constituency level.
    """
    if total_national_votes % 25 != 0:
        raise ValueError(f"total_national_votes ({total_national_votes}) must be a multiple of 25")

    tot_units = total_national_votes // 25
    r_shares = R_continuous / np.sum(R_continuous)
    k = np.floor(r_shares * tot_units).astype(np.int64)
    diff = tot_units - int(np.sum(k))
    rem = (r_shares * tot_units) - k
    k[np.argsort(-rem)[:diff]] += 1
    return k * 25


def _apportion_national_party_integers(shares: np.ndarray, total_national_votes: int) -> np.ndarray:
    """Apportion national vote shares into integer party totals preserving total_national_votes exactly."""
    exact_votes = shares * total_national_votes
    floor_votes = np.floor(exact_votes).astype(np.int64)
    diff = total_national_votes - int(np.sum(floor_votes))
    rem = exact_votes - floor_votes
    floor_votes[np.argsort(-rem)[:diff]] += 1
    return floor_votes


def simulate_election(
    as_of: str | date | None = None,
    election_date: str | date = DEFAULT_ELECTION_DATE,
    samples: int = DEFAULT_SIMULATION_SAMPLES,
    seed: int = DEFAULT_SIMULATION_SEED,
    baseline_year: int = DEFAULT_GEOGRAPHY_BASELINE_YEAR,
    processed_geo_dir: Path | str | None = None,
    total_national_votes: int = 6_500_000,
) -> SimulationResult:
    """Execute complete end-to-end Monte Carlo simulation of the Swedish Riksdag election.

    Pipeline:
        OpinionState v1.1
        -> Dynamics v2 (symmetric_all_history, strictly NO sqrt(h) scaling)
        -> pp_centered_noise (ElectionNoise)
        -> National vote compositions (N, 9)
        -> GeographicProjection v1 (2022 baseline -> 2026 constituencies via IPF)
        -> Exact-Margin Controlled Rounding (Bipartite flow preserving R_c and C_p)
        -> MandateAllocator v1 (Vectorized Sainte-Laguë with legal fallback)
        -> Summary statistics & probabilities
    """
    elec_date = date.fromisoformat(str(election_date)) if isinstance(election_date, str) else election_date
    p_geo_dir = Path(processed_geo_dir) if processed_geo_dir else DEFAULT_PROCESSED_GEOGRAPHY_DIR

    # 1. Canonical National Vote-Share Simulation
    nat_sample_res = generate_national_vote_shares(
        as_of=as_of,
        election_date=elec_date,
        samples=samples,
        seed=seed,
    )
    as_of_date = nat_sample_res.as_of
    nat_shares_matrix = nat_sample_res.nat_shares_matrix  # shape (N, 9) in fractions [0, 1] summing to 1.0

    # Invariant 1: Ensure national shares sum exactly to 100.0%
    vote_shares_pct_matrix = nat_shares_matrix * 100.0

    # 2. Load Precomputed Geographic Baseline Matrix B and Target Row Vector R
    target_year = elec_date.year
    B_cached, R_cached = _get_cached_geography_structures(
        baseline_year=baseline_year,
        target_year=target_year,
        mode="production",
        processed_dir_str=str(p_geo_dir),
    )
    B_base = B_cached.copy()
    R_base = R_cached.copy()

    # Apportion constituency integer target totals R_int as exact multiples of 25
    R_int = _apportion_constituency_units_of_25(R_base, total_national_votes)
    R_col_vec = R_int[:, np.newaxis].astype(np.float64)

    # Resolve official fixed seats for target election
    if target_year == 2018:
        fixed_seats_dict = FIXED_SEATS_2018
    elif target_year == 2022:
        fixed_seats_dict = FIXED_SEATS_2022
    else:
        fixed_seats_dict = FIXED_SEATS_2026
    fixed_seats_arr = np.array([fixed_seats_dict[c] for c in OFFICIAL_CONSTITUENCY_CODES], dtype=np.int64)

    # 3. Batch Geographic Projection + Integerization + Mandate Allocation
    seats_matrix = np.zeros((samples, 8), dtype=np.int64)
    threshold_flags = (nat_shares_matrix[:, :8] >= 0.04)

    X_buf = np.empty((29, 9), dtype=np.float64)

    for i in range(samples):
        # Exact integer national party targets C_int
        C_int = _apportion_national_party_integers(nat_shares_matrix[i], total_national_votes)
        C_row_vec = C_int[np.newaxis, :].astype(np.float64)

        # 9 IPF iterations (converges to < 1e-8 in 9 iterations)
        np.copyto(X_buf, B_base)
        for _ in range(8):
            row_sums = np.sum(X_buf, axis=1, keepdims=True)
            X_buf *= R_col_vec / np.maximum(row_sums, 1e-12)
            col_sums = np.sum(X_buf, axis=0, keepdims=True)
            X_buf *= C_row_vec / np.maximum(col_sums, 1e-12)

        # Exact-margin controlled rounding preserving BOTH R_int and C_int
        cr_res = biproportional_controlled_rounding(X_buf, R_int, C_int, solver="auto")
        int_mat = cr_res.rounded_matrix

        # Mandate allocation
        s_dict = fast_allocate_seats_from_matrix(int_mat, fixed_seats_arr=fixed_seats_arr)
        for p_idx, p in enumerate(PARLIAMENTARY_PARTIES_8):
            seats_matrix[i, p_idx] = s_dict[p]

    # Invariant 2: Total seats per sample strictly equals 349
    sample_seat_totals = np.sum(seats_matrix, axis=1)
    if not np.all(sample_seat_totals == 349):
        bad_idx = np.where(sample_seat_totals != 349)[0]
        raise RuntimeError(f"Seat total invariant violated in {len(bad_idx)} samples: {sample_seat_totals[bad_idx]}")

    # Largest vote and seat party per sample
    largest_vote_idx = np.argmax(nat_shares_matrix[:, :8], axis=1)
    largest_seat_idx = np.argmax(seats_matrix, axis=1)
    largest_vote_parties = [PARLIAMENTARY_PARTIES_8[idx] for idx in largest_vote_idx]
    largest_seat_parties = [PARLIAMENTARY_PARTIES_8[idx] for idx in largest_seat_idx]

    # 4. Reproducibility Manifest
    manifest = build_reproducibility_manifest(
        as_of=as_of_date.isoformat(),
        election_date=elec_date.isoformat(),
        samples=samples,
        base_seed=seed,
        model_config={
            "opinion_model": "OpinionState_v1.1",
            "dynamics_model": "symmetric_all_history",
            "noise_model": "pp_centered_noise",
            "geography_baseline_year": baseline_year,
            "total_national_votes": total_national_votes,
            "constituency_vote_unit": 25,
        },
    )

    # 5. Compute Summary Statistics
    summary_obj, group_helper = compute_simulation_summary(
        as_of=as_of_date.isoformat(),
        election_date=elec_date.isoformat(),
        vote_shares_matrix=nat_shares_matrix,
        seats_matrix=seats_matrix,
        manifest=manifest,
    )

    return SimulationResult(
        summary=summary_obj,
        vote_shares_matrix=vote_shares_pct_matrix,
        seats_matrix=seats_matrix,
        threshold_flags=threshold_flags,
        largest_vote_parties=largest_vote_parties,
        largest_seat_parties=largest_seat_parties,
        group_helper=group_helper,
        manifest=manifest,
    )
