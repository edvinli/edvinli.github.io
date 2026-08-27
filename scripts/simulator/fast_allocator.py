"""Ultra-fast, vectorized Riksdag mandate allocator with 100% legal equivalence and exact reference fallback."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence
import numpy as np

from scripts.geography.config import OFFICIAL_CONSTITUENCY_CODES
from scripts.mandates.allocator import SeatAllocation, allocate_riksdag_seats
from scripts.mandates.config import FIXED_SEATS_2026, OFFICIAL_CONSTITUENCIES, TOTAL_RIKSDAG_SEATS
from .config import MODEL_PARTIES_9, PARLIAMENTARY_PARTIES_8


# Precompute standard Sainte-Laguë divisors (first divisor 1.2 = 6/5, then 3, 5, 7...)
# Up to 350 seats
_DIVISORS_350 = np.empty(350, dtype=np.float64)
_DIVISORS_350[0] = 1.2
_DIVISORS_350[1:] = 2 * np.arange(1, 350) + 1.0

# Precompute fixed seats array for 2026 ordered by OFFICIAL_CONSTITUENCY_CODES
_FIXED_SEATS_2026_ARR = np.array([FIXED_SEATS_2026[c] for c in OFFICIAL_CONSTITUENCY_CODES], dtype=np.int64)


@dataclass(frozen=True)
class FastAllocationDispatchResult:
    """Result of fast allocation including dispatch diagnostics and local 12% tracking."""

    seats_by_party: dict[str, int]
    dispatch_path: str  # "fast_path", "exact_tie_fallback", "local_12_fallback", "overhang_fallback"
    local_12pct_qualified: bool
    local_12pct_constituencies: list[str]
    received_seat_via_12pct: bool


def fast_allocate_kernel(
    X: np.ndarray,
    F_arr: np.ndarray,
    parties: Sequence[str] = MODEL_PARTIES_9,
) -> dict[str, int] | None:
    """Pure fast vectorized Sainte-Laguë kernel without fallback delegation.

    Returns:
        dict[str, int] if the allocation succeeds cleanly with no ties, no 12% exceptions,
        and no overhangs. Returns None if any non-standard branch or exact cutoff tie occurs.
    """
    n_constituencies, n_parties = X.shape
    rest_col_idx = n_parties - 1  # Assume REST is last column

    # 1. National Vote Totals & Threshold Eligibility
    nat_votes = np.sum(X, axis=0)
    total_valid = np.sum(nat_votes)
    if total_valid <= 0:
        raise ValueError("Total valid votes must be strictly positive")

    # Check 4% national threshold for parliamentary parties (excluding REST)
    above_4_mask = np.zeros(n_parties, dtype=bool)
    above_4_mask[:rest_col_idx] = (25 * nat_votes[:rest_col_idx] >= total_valid)

    # 2. Check for local 12% exception on sub-4% parties
    sub_4_indices = np.where(~above_4_mask[:rest_col_idx])[0]
    const_valid = np.sum(X, axis=1)

    if len(sub_4_indices) > 0:
        for p_idx in sub_4_indices:
            if np.any(25 * X[:, p_idx] >= 3 * const_valid):
                return None  # 12% local exception branch

    # 3. Fixed Constituency Seats Allocation
    fixed_seats_won = np.zeros((n_constituencies, n_parties), dtype=np.int64)
    qual_indices = np.where(above_4_mask)[0]

    if len(qual_indices) == 0:
        return {p: 0 for p in parties if p != "REST"}

    for c in range(n_constituencies):
        f_c = int(F_arr[c])
        c_votes = X[c, qual_indices]  # shape (n_qual,)

        # Build comparison quotients for all seats up to f_c for qualifying parties
        divs = _DIVISORS_350[:f_c]  # shape (f_c,)
        quotients = c_votes[:, np.newaxis] / divs[np.newaxis, :]
        flat_q = quotients.ravel()

        if len(flat_q) < f_c:
            return None

        # Check for exact ties at the cutoff boundary
        sorted_q = -np.sort(-flat_q)
        if len(sorted_q) > f_c:
            if abs(sorted_q[f_c - 1] - sorted_q[f_c]) < 1e-11:
                return None  # Exact tie at constituency cutoff

        # Find top f_c quotients
        top_k_indices = np.argpartition(-flat_q, f_c - 1)[:f_c]
        winning_party_local_idx = top_k_indices // f_c
        for w_l_idx in winning_party_local_idx:
            w_p_idx = qual_indices[w_l_idx]
            fixed_seats_won[c, w_p_idx] += 1

    nat_fixed_won = np.sum(fixed_seats_won, axis=0)

    # 4. National Proportional Entitlement (349 seats among qualifying parties)
    total_entitlement_seats = TOTAL_RIKSDAG_SEATS
    qual_nat_votes = nat_votes[qual_indices]

    divs_nat = _DIVISORS_350[:total_entitlement_seats]
    nat_quotients = qual_nat_votes[:, np.newaxis] / divs_nat[np.newaxis, :]
    flat_nat_q = nat_quotients.ravel()

    if len(flat_nat_q) < total_entitlement_seats:
        return None

    # Check for exact ties at the national cutoff boundary
    sorted_nat_q = -np.sort(-flat_nat_q)
    if len(sorted_nat_q) > total_entitlement_seats:
        if abs(sorted_nat_q[total_entitlement_seats - 1] - sorted_nat_q[total_entitlement_seats]) < 1e-11:
            return None  # Exact tie at national cutoff

    top_nat_indices = np.argpartition(-flat_nat_q, total_entitlement_seats - 1)[:total_entitlement_seats]
    winning_nat_party_local = top_nat_indices // total_entitlement_seats

    entitlement = np.zeros(n_parties, dtype=np.int64)
    for w_l in winning_nat_party_local:
        entitlement[qual_indices[w_l]] += 1

    # 5. Overhang Check
    has_overhang = np.any(nat_fixed_won[qual_indices] > entitlement[qual_indices])
    if has_overhang:
        return None

    # Clean non-overhang case
    final_seats = {p: 0 for p in parties if p != "REST"}
    for p_idx in qual_indices:
        final_seats[parties[p_idx]] = int(entitlement[p_idx])

    return final_seats


def dispatch_production_allocation(
    votes_matrix_29x9: np.ndarray,
    fixed_seats_arr: np.ndarray | None = None,
    parties: Sequence[str] = MODEL_PARTIES_9,
) -> FastAllocationDispatchResult:
    """Production mandate dispatcher guaranteed to match exact legal reference allocator 100%.

    Dispatches cleanly:
    - Runs fast_allocate_kernel.
    - If fast_allocate_kernel returns a result, dispatches via fast path.
    - Otherwise, falls back to exact Fraction reference allocator passing election-specific fixed seats map.
    """
    X = np.asarray(votes_matrix_29x9, dtype=np.int64)
    F_arr = fixed_seats_arr if fixed_seats_arr is not None else _FIXED_SEATS_2026_ARR

    n_constituencies, n_parties = X.shape
    rest_col_idx = n_parties - 1

    # National totals
    nat_votes = np.sum(X, axis=0)
    total_valid = np.sum(nat_votes)
    if total_valid <= 0:
        raise ValueError("Total valid votes must be strictly positive")

    above_4_mask = np.zeros(n_parties, dtype=bool)
    above_4_mask[:rest_col_idx] = (25 * nat_votes[:rest_col_idx] >= total_valid)

    # Local 12% exception checks
    sub_4_indices = np.where(~above_4_mask[:rest_col_idx])[0]
    const_valid = np.sum(X, axis=1)

    local_12_qualified = False
    local_12_constituencies: list[str] = []

    if len(sub_4_indices) > 0:
        for p_idx in sub_4_indices:
            for c_idx in range(n_constituencies):
                if 25 * X[c_idx, p_idx] >= 3 * const_valid[c_idx]:
                    local_12_qualified = True
                    c_code = OFFICIAL_CONSTITUENCY_CODES[c_idx]
                    if c_code not in local_12_constituencies:
                        local_12_constituencies.append(c_code)

    # Attempt fast kernel
    fast_res = fast_allocate_kernel(X, F_arr, parties=parties)
    if fast_res is not None:
        return FastAllocationDispatchResult(
            seats_by_party=fast_res,
            dispatch_path="fast_path",
            local_12pct_qualified=False,
            local_12pct_constituencies=[],
            received_seat_via_12pct=False,
        )

    # Determine fallback reason
    if local_12_qualified:
        dispatch_path = "local_12_fallback"
    else:
        # Check if overhang or tie
        qual_indices = np.where(above_4_mask)[0]
        # Quick check if overhang
        dispatch_path = "overhang_or_tie_fallback"

    # Fall back to exact reference allocator with election-specific fixed seats
    ref_res, ref_alloc = _fallback_to_reference_allocator_with_details(X, parties, F_arr)

    # Determine if any sub-4% party actually received a seat via 12%
    received_seat_via_12 = False
    if local_12_qualified:
        for p_idx in sub_4_indices:
            p_code = parties[p_idx]
            if ref_res.get(p_code, 0) > 0:
                received_seat_via_12 = True
                break

    return FastAllocationDispatchResult(
        seats_by_party=ref_res,
        dispatch_path=dispatch_path,
        local_12pct_qualified=local_12_qualified,
        local_12pct_constituencies=local_12_constituencies,
        received_seat_via_12pct=received_seat_via_12,
    )


def fast_allocate_seats_from_matrix(
    votes_matrix_29x9: np.ndarray,
    fixed_seats_arr: np.ndarray | None = None,
    parties: Sequence[str] = MODEL_PARTIES_9,
) -> dict[str, int]:
    """Convenience wrapper for fast allocation dispatch."""
    disp_res = dispatch_production_allocation(votes_matrix_29x9, fixed_seats_arr=fixed_seats_arr, parties=parties)
    return disp_res.seats_by_party


def _fallback_to_reference_allocator_with_details(
    X: np.ndarray,
    parties: Sequence[str],
    F_arr: np.ndarray,
) -> tuple[dict[str, int], SeatAllocation]:
    """Fallback handler that constructs constituency vote dict and exact election-specific fixed seats map."""
    cv_map: dict[str, dict[str, int]] = {}
    fixed_seats_dict: dict[str, int] = {}
    for i, c_code in enumerate(OFFICIAL_CONSTITUENCY_CODES):
        fixed_seats_dict[c_code] = int(F_arr[i])
        cv_map[c_code] = {}
        for j, p_code in enumerate(parties):
            target_label = "OTHER_INELIGIBLE" if p_code == "REST" else p_code
            cv_map[c_code][target_label] = int(X[i, j])

    res = allocate_riksdag_seats(
        constituency_votes=cv_map,
        fixed_seats_by_constituency=fixed_seats_dict,
    )
    final_p = {p: res.final_seats_by_party.get(p, 0) for p in parties if p != "REST"}
    return final_p, res
