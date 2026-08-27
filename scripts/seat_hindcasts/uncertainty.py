"""Uncertainty attribution for historical Riksdag seat hindcasts."""

from __future__ import annotations

from typing import Any
import numpy as np

from scripts.simulator.config import PARLIAMENTARY_PARTIES_8


def attribute_seat_uncertainty(
    vote_shares_matrix: np.ndarray,  # shape (N, 9) in percent
    seats_matrix: np.ndarray,        # shape (N, 8) in integer seats
    parties: tuple[str, ...] = PARLIAMENTARY_PARTIES_8,
) -> dict[str, dict[str, Any]]:
    """Attribute seat uncertainty to national vote variance, 4% threshold crossing, and mandate mechanics.

    Parameters:
        vote_shares_matrix: (N, 9) percentage vote share draws.
        seats_matrix: (N, 8) integer seat draws.
        parties: 8 parliamentary party codes.

    Returns:
        Dictionary mapping party -> attribution diagnostic dict.
    """
    n_samples = len(seats_matrix)
    attribution = {}

    for idx, p in enumerate(parties):
        v = vote_shares_matrix[:, idx]
        s = seats_matrix[:, idx]

        v_mean = float(np.mean(v))
        v_std = float(np.std(v))
        s_mean = float(np.mean(s))
        s_std = float(np.std(s))

        # Threshold crossing probability
        p_qual = float(np.mean(v >= 4.0))
        threshold_uncertainty_score = float(4.0 * p_qual * (1.0 - p_qual))  # 1.0 when p_qual = 0.5, 0.0 when 0 or 1

        # Conditional variance given qualification
        if p_qual > 0.01:
            s_qual = s[v >= 4.0]
            s_std_conditional = float(np.std(s_qual))
        else:
            s_std_conditional = 0.0

        # Primary driver classification
        if threshold_uncertainty_score > 0.20:
            primary_driver = "4% Threshold Crossing (Cliff Effect)"
        elif v_std > 1.5:
            primary_driver = "National Vote Uncertainty"
        else:
            primary_driver = "Mandate Allocation & Geographic Mechanics"

        attribution[p] = {
            "vote_mean": round(v_mean, 2),
            "vote_std": round(v_std, 2),
            "seats_mean": round(s_mean, 2),
            "seats_std": round(s_std, 2),
            "prob_qualify": round(p_qual, 4),
            "threshold_cliff_score": round(threshold_uncertainty_score, 4),
            "seats_std_given_qualify": round(s_std_conditional, 2),
            "primary_driver": primary_driver,
        }

    return attribution
