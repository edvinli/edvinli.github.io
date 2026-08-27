"""Complete historical probabilistic Riksdag seat hindcast pipeline (SeatHindcast v1)."""

from __future__ import annotations

import argparse
from datetime import date, timedelta
import json
from pathlib import Path
import time
from typing import Any
import numpy as np
import pandas as pd

from scripts.simulator.config import PARLIAMENTARY_PARTIES_8
from .config import (
    DEFAULT_HORIZONS,
    DEFAULT_OUTPUT_DIR,
    DEFAULT_SAMPLES,
    DEFAULT_SEED,
    EVALUATION_ELECTIONS,
)
from .metrics import (
    calculate_discrete_seat_crps,
    calculate_empirical_percentile,
    calculate_interval_coverage_and_width,
    calculate_multivariate_energy_score,
)
from .models import (
    evaluate_election_simulator_v1,
    evaluate_seat_point_baseline,
)
from .uncertainty import attribute_seat_uncertainty


def run_seat_hindcasts(
    samples: int = DEFAULT_SAMPLES,
    seed: int = DEFAULT_SEED,
    horizons: tuple[int, ...] = DEFAULT_HORIZONS,
    output_dir: Path | str = DEFAULT_OUTPUT_DIR,
) -> dict[str, Any]:
    """Execute complete 2018 and 2022 seat hindcasts across all specified horizons."""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("==========================================================================================")
    print("RUNNING PROBABILISTIC SEAT HINDCASTS (SeatHindcast v1)")
    print(f"Elections: 2018, 2022 | Horizons: {horizons} | Samples: {samples:,} | Seed: {seed}")
    print("==========================================================================================")

    all_results = []
    party_summaries = []

    t_start = time.perf_counter()

    for year_str, e_info in EVALUATION_ELECTIONS.items():
        elec_date = e_info["election_date"]
        base_geo_year = e_info["geography_baseline_year"]
        actual_seats = e_info["actual_seats"]
        actual_shares = e_info["actual_shares"]
        actual_seat_vec = np.array([actual_seats[p] for p in PARLIAMENTARY_PARTIES_8], dtype=np.int64)

        for h in horizons:
            as_of = elec_date - timedelta(days=h)
            print(f"\n>>> Running Hindcast: {year_str} (Election: {elec_date}) | Horizon: {h:3d}d | As-Of: {as_of} | Geo: {base_geo_year} ...")

            # 1. Evaluate Point Baseline
            point_seats = evaluate_seat_point_baseline(
                as_of=as_of,
                election_date=elec_date,
                baseline_year=base_geo_year,
            )
            point_seat_vec = np.array([point_seats.get(p, 0) for p in PARLIAMENTARY_PARTIES_8], dtype=np.int64)
            point_mae = float(np.mean(np.abs(point_seat_vec - actual_seat_vec)))

            # 2. Evaluate ElectionSimulator v1
            sim_res = evaluate_election_simulator_v1(
                as_of=as_of,
                election_date=elec_date,
                baseline_year=base_geo_year,
                samples=samples,
                seed=seed,
            )

            seats_matrix = sim_res.seats_matrix  # shape (N, 8)
            vote_shares_matrix = sim_res.vote_shares_matrix  # shape (N, 9)

            # 3. Compute Multivariate Energy Score
            es = calculate_multivariate_energy_score(seats_matrix, actual_seat_vec)

            # 4. Compute Per-Party Probabilistic Seat Metrics
            party_metrics = {}
            for p_idx, p in enumerate(PARLIAMENTARY_PARTIES_8):
                p_draws = seats_matrix[:, p_idx]
                act_s = actual_seats[p]

                mean_s = float(np.mean(p_draws))
                median_s = int(np.median(p_draws))
                mae_s = float(np.mean(np.abs(p_draws - act_s)))
                crps_s = calculate_discrete_seat_crps(p_draws, act_s)
                perc_s = calculate_empirical_percentile(p_draws, act_s)

                cov50, w50, _, _ = calculate_interval_coverage_and_width(p_draws, act_s, level=0.50)
                cov80, w80, _, _ = calculate_interval_coverage_and_width(p_draws, act_s, level=0.80)
                cov90, w90, _, _ = calculate_interval_coverage_and_width(p_draws, act_s, level=0.90)

                party_metrics[p] = {
                    "party": p,
                    "actual_seats": act_s,
                    "point_baseline_seats": int(point_seat_vec[p_idx]),
                    "mean_seats": round(mean_s, 2),
                    "median_seats": median_s,
                    "mae": round(mae_s, 2),
                    "crps": round(crps_s, 4),
                    "percentile": round(perc_s, 1),
                    "cov_50": cov50,
                    "width_50": w50,
                    "cov_80": cov80,
                    "width_80": w80,
                    "cov_90": cov90,
                    "width_90": w90,
                    "p_largest": float(np.mean(np.array(sim_res.largest_seat_parties) == p)),
                    "p_qualify": float(np.mean(vote_shares_matrix[:, p_idx] >= 4.0)),
                    "p_any_seats": float(np.mean(p_draws > 0)),
                }

                party_summaries.append({
                    "election_year": int(year_str),
                    "horizon_days": h,
                    "as_of": as_of.isoformat(),
                    **party_metrics[p],
                })

            # 5. Group Majorities
            tido_summary = sim_res.summarize_group(["M", "SD", "KD", "L"])
            rgc_summary = sim_res.summarize_group(["S", "V", "MP", "C"])

            # 6. Uncertainty Attribution
            uncertainty_attr = attribute_seat_uncertainty(vote_shares_matrix, seats_matrix)

            # Average metrics across parties
            mean_crps = float(np.mean([m["crps"] for m in party_metrics.values()]))
            mean_mae = float(np.mean([m["mae"] for m in party_metrics.values()]))

            print(f"  Result -> Simulator MAE: {mean_mae:.2f} seats | Point MAE: {point_mae:.2f} seats | Mean CRPS: {mean_crps:.3f} | Joint Energy Score: {es:.3f}")

            case_record = {
                "election_year": int(year_str),
                "election_date": elec_date.isoformat(),
                "horizon_days": h,
                "as_of": as_of.isoformat(),
                "geography_baseline_year": base_geo_year,
                "point_baseline_mae": round(point_mae, 3),
                "simulator_mean_mae": round(mean_mae, 3),
                "simulator_mean_crps": round(mean_crps, 4),
                "joint_energy_score": round(es, 4),
                "party_metrics": party_metrics,
                "bloc_majorities": {
                    "tido_mean_seats": round(tido_summary.mean_seats, 2),
                    "tido_prob_majority": round(tido_summary.prob_majority, 4),
                    "rgc_mean_seats": round(rgc_summary.mean_seats, 2),
                    "rgc_prob_majority": round(rgc_summary.prob_majority, 4),
                },
                "uncertainty_attribution": uncertainty_attr,
            }
            all_results.append(case_record)

    total_time = time.perf_counter() - t_start
    print(f"\n==========================================================================================")
    print(f"ALL 12 HINDCASTS COMPLETED IN {total_time:.2f} s")
    print(f"==========================================================================================")

    # Convert to DataFrames and aggregate summaries
    df_parties = pd.DataFrame(party_summaries)
    df_cases = pd.DataFrame([{
        "election_year": c["election_year"],
        "horizon_days": c["horizon_days"],
        "point_baseline_mae": c["point_baseline_mae"],
        "simulator_mae": c["simulator_mean_mae"],
        "simulator_crps": c["simulator_mean_crps"],
        "energy_score": c["joint_energy_score"],
        "cov_50": float(np.mean([c["party_metrics"][p]["cov_50"] for p in PARLIAMENTARY_PARTIES_8])),
        "cov_80": float(np.mean([c["party_metrics"][p]["cov_80"] for p in PARLIAMENTARY_PARTIES_8])),
        "cov_90": float(np.mean([c["party_metrics"][p]["cov_90"] for p in PARLIAMENTARY_PARTIES_8])),
    } for c in all_results])

    # Overall Summary Stats
    summary_report = {
        "metadata": {
            "model": "ElectionSimulator_v1",
            "samples": samples,
            "seed": seed,
            "elections": [2018, 2022],
            "horizons": list(horizons),
            "total_evaluations": len(all_results),
            "generated_at": date.today().isoformat(),
        },
        "aggregate_performance": {
            "overall": {
                "point_baseline_mae": round(float(df_cases["point_baseline_mae"].mean()), 3),
                "simulator_mae": round(float(df_cases["simulator_mae"].mean()), 3),
                "simulator_crps": round(float(df_cases["simulator_crps"].mean()), 4),
                "energy_score": round(float(df_cases["energy_score"].mean()), 4),
                "coverage_50": round(float(df_cases["cov_50"].mean()), 3),
                "coverage_80": round(float(df_cases["cov_80"].mean()), 3),
                "coverage_90": round(float(df_cases["cov_90"].mean()), 3),
            },
            "by_election": {
                "2018": {
                    "point_baseline_mae": round(float(df_cases[df_cases["election_year"] == 2018]["point_baseline_mae"].mean()), 3),
                    "simulator_mae": round(float(df_cases[df_cases["election_year"] == 2018]["simulator_mae"].mean()), 3),
                    "simulator_crps": round(float(df_cases[df_cases["election_year"] == 2018]["simulator_crps"].mean()), 4),
                    "energy_score": round(float(df_cases[df_cases["election_year"] == 2018]["energy_score"].mean()), 4),
                    "coverage_50": round(float(df_cases[df_cases["election_year"] == 2018]["cov_50"].mean()), 3),
                    "coverage_80": round(float(df_cases[df_cases["election_year"] == 2018]["cov_80"].mean()), 3),
                    "coverage_90": round(float(df_cases[df_cases["election_year"] == 2018]["cov_90"].mean()), 3),
                },
                "2022": {
                    "point_baseline_mae": round(float(df_cases[df_cases["election_year"] == 2022]["point_baseline_mae"].mean()), 3),
                    "simulator_mae": round(float(df_cases[df_cases["election_year"] == 2022]["simulator_mae"].mean()), 3),
                    "simulator_crps": round(float(df_cases[df_cases["election_year"] == 2022]["simulator_crps"].mean()), 4),
                    "energy_score": round(float(df_cases[df_cases["election_year"] == 2022]["energy_score"].mean()), 4),
                    "coverage_50": round(float(df_cases[df_cases["election_year"] == 2022]["cov_50"].mean()), 3),
                    "coverage_80": round(float(df_cases[df_cases["election_year"] == 2022]["cov_80"].mean()), 3),
                    "coverage_90": round(float(df_cases[df_cases["election_year"] == 2022]["cov_90"].mean()), 3),
                },
            },
            "by_horizon": {
                str(h): {
                    "point_baseline_mae": round(float(df_cases[df_cases["horizon_days"] == h]["point_baseline_mae"].mean()), 3),
                    "simulator_mae": round(float(df_cases[df_cases["horizon_days"] == h]["simulator_mae"].mean()), 3),
                    "simulator_crps": round(float(df_cases[df_cases["horizon_days"] == h]["simulator_crps"].mean()), 4),
                    "energy_score": round(float(df_cases[df_cases["horizon_days"] == h]["energy_score"].mean()), 4),
                } for h in horizons
            },
        },
        "cases": all_results,
    }

    # Save to JSON
    json_path = out_dir / "seat_hindcast_summary.json"
    with open(json_path, "w") as f:
        json.dump(summary_report, f, indent=2)

    # Save detailed CSV
    csv_path = out_dir / "seat_hindcast_parties_detail.csv"
    df_parties.to_csv(csv_path, index=False)

    print(f"\nSaved seat hindcast summary to {json_path}")
    print(f"Saved party details table to {csv_path}")

    return summary_report


def main():
    parser = argparse.ArgumentParser(description="Run SeatHindcast v1 Historical Benchmarks")
    parser.add_argument("--samples", type=int, default=DEFAULT_SAMPLES, help="Monte Carlo samples per hindcast")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Base random seed")
    args = parser.parse_args()

    run_seat_hindcasts(samples=args.samples, seed=args.seed)


if __name__ == "__main__":
    main()
