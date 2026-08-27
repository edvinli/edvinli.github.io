"""Adversarial stress test suite comparing fast mandate allocator against exact reference oracle across 20,000+ cases."""

import unittest
import numpy as np

from scripts.geography.config import OFFICIAL_CONSTITUENCY_CODES
from scripts.mandates.allocator import allocate_riksdag_seats
from scripts.mandates.config import FIXED_SEATS_2026, TOTAL_RIKSDAG_SEATS
from scripts.simulator.config import MODEL_PARTIES_9, PARLIAMENTARY_PARTIES_8
from scripts.simulator.engine import _apportion_constituency_units_of_25, _apportion_national_party_integers
from scripts.simulator.fast_allocator import fast_allocate_seats_from_matrix


class TestAdversarialMandateAllocation(unittest.TestCase):
    """Stress testing fast vectorized allocator vs legal reference oracle on 20,000 deterministic adversarial cases."""

    def test_20000_adversarial_fast_vs_exact_cases(self) -> None:
        """Run 20,000 deterministic adversarial cases covering edge cases, overhangs, returns, and ties."""
        n_cases = 20_000
        rng = np.random.default_rng(20260913)
        tot_votes = 6_500_000

        mismatches = 0
        total_seats_violations = 0

        # Generate 20,000 test configurations
        for i in range(n_cases):
            case_type = i % 5

            if case_type == 0:
                # 1. Dense national threshold sweep [3.5%, 4.5%] for L, KD, MP
                base = [18.0, 3.5 + (i % 100) * 0.01, 6.0, 3.6 + ((i // 3) % 90) * 0.01, 30.0, 7.5, 3.7 + ((i // 7) % 80) * 0.01, 19.0, 2.0]
                shares = np.array(base) / sum(base)
                C_int = _apportion_national_party_integers(shares, tot_votes)
                # Spread across constituencies
                mat = np.outer(np.ones(29) / 29.0, C_int).astype(np.int64)
                mat[0] += C_int - np.sum(mat, axis=0)

            elif case_type == 1:
                # 2. Local 12% exception stress test in constituency 01 and 02 [10% to 14%]
                base = [18.0, 3.2, 6.0, 5.5, 32.0, 8.0, 5.5, 19.0, 2.8]
                shares = np.array(base) / sum(base)
                C_int = _apportion_national_party_integers(shares, tot_votes)
                mat = np.outer(np.ones(29) / 29.0, C_int).astype(np.int64)
                mat[0] += C_int - np.sum(mat, axis=0)
                # Inject 10-14% local vote for sub-4% party L (col 1) in constituency 01 (Stockholm kommun)
                local_pct = 0.10 + (i % 40) * 0.001
                c0_tot = np.sum(mat[0])
                mat[0, 1] = int(c0_tot * local_pct)
                # Rebalance
                mat[0, 4] = max(100, c0_tot - int(np.sum(mat[0, :4])) - int(np.sum(mat[0, 5:])))

            elif case_type == 2:
                # 3. Massive Overhang triggering multiple returned fixed seats
                base = [15.0, 2.0, 5.0, 5.0, 35.0, 8.0, 6.0, 22.0, 2.0]
                shares = np.array(base) / sum(base)
                C_int = _apportion_national_party_integers(shares, tot_votes)
                mat = np.outer(np.ones(29) / 29.0, C_int).astype(np.int64)
                mat[0] += C_int - np.sum(mat, axis=0)
                # Concentrate party M (col 0) heavily in large constituencies to trigger overhang
                mat[0, 0] += 80_000
                mat[1, 0] += 70_000
                mat[2, 0] += 50_000

            elif case_type == 3:
                # 4. Multiple sub-4% local qualifiers receiving returned seats
                base = [16.0, 3.1, 5.5, 3.2, 33.0, 7.5, 3.3, 26.0, 2.4]
                shares = np.array(base) / sum(base)
                C_int = _apportion_national_party_integers(shares, tot_votes)
                mat = np.outer(np.ones(29) / 29.0, C_int).astype(np.int64)
                mat[0] += C_int - np.sum(mat, axis=0)
                # Sub-4% parties get local 12% in c=01, 02, 03
                mat[0, 1] = int(np.sum(mat[0]) * 0.13)
                mat[1, 3] = int(np.sum(mat[1]) * 0.14)
                mat[2, 6] = int(np.sum(mat[2]) * 0.135)
                # Overhang in dominant party
                mat[0, 4] += 60_000

            else:
                # 5. Near-tie comparison quotients and Gotland test
                base = [19.0, 4.0, 5.0, 5.0, 30.0, 8.0, 8.0, 19.0, 2.0]
                shares = np.array(base) / sum(base)
                C_int = _apportion_national_party_integers(shares, tot_votes)
                mat = np.outer(np.ones(29) / 29.0, C_int).astype(np.int64)
                mat[0] += C_int - np.sum(mat, axis=0)
                # Gotland (c=8, code 09) has 2 fixed seats; give low comparison quotients
                mat[8, :] = [500, 500, 500, 500, 1000, 400, 400, 600, 100]
                # Ties between parties in constituency 04
                mat[3, 0] = 10_000
                mat[3, 7] = 10_000

            # Execute fast allocator
            fast_seats = fast_allocate_seats_from_matrix(mat)
            tot_fast = sum(fast_seats.values())
            if tot_fast != TOTAL_RIKSDAG_SEATS:
                total_seats_violations += 1

            # Execute exact reference allocator
            cv_map = {}
            for row_i, c_code in enumerate(OFFICIAL_CONSTITUENCY_CODES):
                cv_map[c_code] = {}
                for col_j, p in enumerate(MODEL_PARTIES_9):
                    lbl = "OTHER_INELIGIBLE" if p == "REST" else p
                    cv_map[c_code][lbl] = int(mat[row_i, col_j])

            ref_res = allocate_riksdag_seats(cv_map, FIXED_SEATS_2026)
            ref_seats = {p: ref_res.final_seats_by_party.get(p, 0) for p in PARLIAMENTARY_PARTIES_8}

            if fast_seats != ref_seats:
                mismatches += 1

        self.assertEqual(total_seats_violations, 0, f"Total seats violated in {total_seats_violations} cases")
        self.assertEqual(mismatches, 0, f"Mismatches between fast and exact allocator in {mismatches} / {n_cases} cases")


if __name__ == "__main__":
    unittest.main()
