"""Join separately run policies on matching benchmark games.

Usage: python3 experiments/merge.py reference.jsonl candidate.jsonl paired.jsonl
"""
import json
import math
import statistics
import sys
from pathlib import Path

reference_path, candidate_path, output_path = map(Path, sys.argv[1:])


def read(path):
    records = [json.loads(line) for line in path.read_text().splitlines()]
    games = [record for record in records if "game" in record]
    summaries = [record for record in records if "policy" in record]
    if len(summaries) != 1 or len(games) != summaries[0]["games"]:
        raise ValueError(f"Expected one complete policy run: {path}")
    return games, summaries[0]


reference, ref_summary = read(reference_path)
candidate, candidate_summary = read(candidate_path)
for field in ["games", "samples", "seed", "placement"]:
    if ref_summary[field] != candidate_summary[field]:
        raise ValueError(f"Mismatched {field}")
if ref_summary["policy"] == candidate_summary["policy"]:
    raise ValueError("Expected different policies")
paired = []
for index, (left, right) in enumerate(zip(reference, candidate), 1):
    if left["game"] != index or right["game"] != index:
        raise ValueError("Mismatched game order")
    paired.append({"game": index, "shots": {**left["shots"], **right["shots"]}})
differences = [row["shots"][candidate_summary["policy"]] - row["shots"][ref_summary["policy"]] for row in paired]
delta = statistics.mean(differences)
error = statistics.stdev(differences) / math.sqrt(len(differences))
candidate_summary.update(delta=delta, pairedSE=error, pairedCI95=[delta - 1.96 * error, delta + 1.96 * error])
# Preserve original timing and limit metadata, with the paired comparison fixed.
output_path.write_text("".join(json.dumps(row) + "\n" for row in paired + [ref_summary, candidate_summary]))
