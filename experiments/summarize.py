"""Recompute paired comparisons from per-game JSONL, ignoring stored summaries.

Usage: python3 experiments/summarize.py experiments/discovery.jsonl [...]
"""
import json
import math
import statistics
import sys
from pathlib import Path

for argument in sys.argv[1:]:
    path = Path(argument)
    records = [json.loads(line) for line in path.read_text().splitlines()]
    rows = [record["shots"] for record in records if "game" in record]
    if len(rows) < 2:
        raise ValueError(f"At least two games required: {path}")
    policies = list(rows[0])
    if any(list(row) != policies for row in rows):
        raise ValueError(f"Mixed policy sets: {path}")
    print(f"\n{path.name}: {len(rows)} games; reference = {policies[0]}")
    print("| Policy | Mean shots | Difference | Paired 95% interval |")
    print("|---|---:|---:|---:|")
    for policy in policies:
        mean = statistics.mean(row[policy] for row in rows)
        differences = [row[policy] - row[policies[0]] for row in rows]
        delta = statistics.mean(differences)
        error = statistics.stdev(differences) / math.sqrt(len(differences))
        print(f"| {policy} | {mean:.3f} | {delta:+.3f} | [{delta - 1.96 * error:+.3f}, {delta + 1.96 * error:+.3f}] |")
