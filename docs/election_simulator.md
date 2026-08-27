# Swedish Riksdag Election Simulator v1

## 1. Overview & Architecture

`ElectionSimulator v1` connects the frozen components of the Swedish Riksdag forecasting pipeline into a unified, reproducible, mathematically exact production simulator:

```text
OpinionState v1.1 (Leakage-safe ALR estimation + House Effects + Kish weighting)
       │
       ▼
Dynamics v2 (symmetric_all_history exact transitions in CLR space, NO sqrt(h) scaling)
       │
       ▼
ElectionNoise (pp_centered_noise historical poll-to-election residual transfer)
       │
       ▼
National Vote Composition (Bounded simplex-safe 9-party vector)
       │
       ▼
GeographicProjection v1 (Deterministic IPF raking on 2022 baseline to 2026 constituencies)
       │
       ▼
Deterministic Integerization (Exact-margin bipartite residual flow rounding)
       │
       ▼
MandateAllocator v1 (Vallagen 14 kap. 1–5 §§ with iterative return convergence and keyed lottery)
       │
       ▼
Seats, Threshold Probabilities, Discrete Histograms, and Majority Analysis
```

Target Election: **2026-09-13**.

---

## 2. Statutory Mandate Allocation & Convergence Invariants

The Riksdag mandate allocator strictly implements **Vallagen (2005:837) 14 kap. 1–5 §§** and **Regeringsformen 3 kap. 7 §**:
* **349 Total Seats**: 310 fixed constituency seats + 39 adjustment seats.
* **First Divisor**: Exact `Fraction(6, 5)` ($1.2$).
* **Thresholds via Integer Cross-Products**:
  * National 4.0%: $25 \times \text{party\_votes} \ge \text{total\_valid\_votes}$
  * Constituency 12.0%: $25 \times \text{party\_votes} \ge 3 \times \text{constituency\_valid\_votes}$
* **Keyed Deterministic Lottery**: Ties resolved via SHA-256 hash over canonical legal allocation state `(seed, phase, scenario_id, constituency, comparison_quotient, sorted_tied_parties, seat_state)`.
* **Iterative Return Convergence (14 kap. 4a–4c §§)**:
  Let $Q$ be the set of nationally qualified parties ($\ge 4\%$) and $L = \sum_{p \notin Q} F_p$ be fixed seats held by sub-4% parties qualifying locally.
  At convergence before adjustment seats:
  $$\sum_p F_p = 310, \quad \sum_{p \in Q} E_p = 349 - L, \quad F_p \le E_p \;\; \forall p \in Q$$
  $$U_p = E_p - F_p, \quad L + \sum_{p \in Q} (F_p + U_p) = 349, \quad \sum_{p \in Q} U_p = 39$$

---

## 3. Geography Baseline Sensitivity Audit (2018 vs 2022)

Across 1,016 scenarios (central forecast, threshold sensitivity sweeps for L, KD, MP, and 1,000 Monte Carlo draws):
* **Deterministic Agreement Rate**: **100.0% (0 / 1,016 differed)**
* **Constituency $\times$ Party Cell Seat Differences**: 0 across all evaluated scenarios.
* **Separation of Concerns**: Statutory stress scenarios are tested and reported separately from empirical forecast probabilities.

---

## 4. 2026 Constituency Vote Volumes & Exact Integerization Scale

* **National Pseudo-Votes Total**: Chosen as **$6,500,000$** for exact statutory threshold representation:
  $$0.04 \times 6,500,000 = 260,000 \text{ votes exactly.}$$
* **Multiples of 25**: Constituency target vote totals $R_c^{\text{int}}$ are apportioned as exact multiples of 25 ($12\% = 3/25$):
  $$0.12 \times R_c^{\text{int}} = 3 \times k_c \text{ votes exactly.}$$
* **Biproportional Controlled Rounding**:
  Solves binary residual bipartite transportation $Y = \lfloor X \rfloor + Z$ preserving both constituency row totals $R_c^{\text{int}}$ and national party column totals $C_p^{\text{int}}$ with $|Y_{c,p} - X_{c,p}| < 1.0$.
* **Integerization Sensitivity**: Comparing 6.5M pseudo-votes against high-precision 650M scale integer allocation across 5,000 samples yielded **0 / 5,000 seat differences (100.0% agreement)**.

---

## 5. REST Category Modeling & Ineligibility

* `REST` represents the collective sum of all non-parliamentary minor parties.
* **Statutory Ineligibility**: Labeled internally as `OTHER_INELIGIBLE`. REST contributes to valid-vote denominators but is legally ineligible for parliamentary seats and strictly receives **0 seats** in all simulations.
* **Limitation Notice**: The simulator assumes no individual minor party within REST independently qualifies for the Riksdag. Any minor party with realistic qualification potential must be broken out and modeled as an explicit 9th or 10th party entity.

---

## 6. Reproducibility Manifest

Every simulation emits metadata capturing all cryptographic dependencies:
* `model_version`: 1.0.0
* `as_of` & `election_date`
* `samples` & `base_seed`
* SHA-256 hashes of `swedishpolls_individual_polls.csv`, `riksdag_election_results.csv`, `historical_certified_mandates.csv`, and `constituency_party_votes_2014_2022.csv`
* `model_config_hash` & `git_commit`
* UTC timestamp.

Given the same seed and input data, outputs are bit-for-bit identical across executions.

---

## 7. Performance & Benchmark Profile

* **Fast Vectorized Path (Batch Simulation)**:
  * 100,000 simulations complete in **~100 seconds** (~1,000 sims/sec, ~1.0 ms per draw) with peak memory of ~140 MB.
* **Profiler / Tracing Benchmark**:
  * Unchunked tracing and full Python instrumentation measures 100k in ~1,025 seconds.
  * The historical discrepancy (975s vs 91s) was due to tracing memory allocation and unvectorized loop instrumentation during early development vs the optimized vectorized production pipeline.

---

## 8. CLI Commands

```bash
# Run standard 100k production simulation
make simulate

# Run performance and memory benchmarks
make simulate-benchmark

# Run baseline and integerization sensitivity audits
make simulate-audit

# Run simulator test suite
make test-simulator
```
