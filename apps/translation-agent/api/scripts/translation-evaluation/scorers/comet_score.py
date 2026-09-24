#!/usr/bin/env python3
"""
COMET scoring script for translation evaluation.
Reads JSON from stdin, outputs scores to stdout.

Single mode input format:
{
  "mode": "single",
  "segments": [
    {"src": "source text", "mt": "machine translation", "ref": "reference"},
    ...
  ]
}

Compare mode input format:
{
  "mode": "compare",
  "sources": ["source1", "source2", ...],
  "references": ["ref1", "ref2", ...],
  "systems": {
    "qwen": ["hyp1", "hyp2", ...],
    "deepl": ["hyp1", "hyp2", ...],
    ...
  }
}

Single mode output:
{
  "scores": [0.85, 0.92, ...],
  "system_score": 0.88
}

Compare mode output:
{
  "systems": {
    "qwen": {"scores": [...], "system_score": 0.88},
    "deepl": {"scores": [...], "system_score": 0.85}
  },
  "ranking": [{"system": "qwen", "score": 0.88}, ...],
  "pairwise": [{"system1": "qwen", "system2": "deepl", "winner": "qwen", "diff": 0.03}]
}
"""

import sys
import json
from comet import download_model, load_from_checkpoint


def score_single(model, segments):
    """Score a single hypothesis system."""
    predictions = model.predict(segments, batch_size=8, gpus=1)
    return {
        "scores": predictions.scores,
        "system_score": predictions.system_score
    }


def score_compare(model, sources, references, systems):
    """Compare multiple hypothesis systems."""
    results = {}
    
    for system_name, hypotheses in systems.items():
        segments = [
            {"src": src, "mt": hyp, "ref": ref}
            for src, hyp, ref in zip(sources, hypotheses, references)
        ]
        predictions = model.predict(segments, batch_size=8, gpus=1)
        results[system_name] = {
            "scores": predictions.scores,
            "system_score": predictions.system_score
        }
    
    ranking = sorted(
        [{"system": name, "score": data["system_score"]} for name, data in results.items()],
        key=lambda x: x["score"],
        reverse=True
    )
    
    pairwise = []
    system_names = list(systems.keys())
    for i in range(len(system_names)):
        for j in range(i + 1, len(system_names)):
            s1, s2 = system_names[i], system_names[j]
            score1, score2 = results[s1]["system_score"], results[s2]["system_score"]
            diff = abs(score1 - score2)
            winner = s1 if score1 > score2 else (s2 if score2 > score1 else None)
            pairwise.append({
                "system1": s1,
                "system2": s2,
                "winner": winner,
                "diff": diff
            })
    
    return {
        "systems": results,
        "ranking": ranking,
        "pairwise": pairwise
    }


def main():
    try:
        input_data = json.loads(sys.stdin.read())
        
        model_path = download_model("Unbabel/wmt22-comet-da")
        model = load_from_checkpoint(model_path)
        
        mode = input_data.get("mode", "single")
        
        if mode == "single":
            segments = input_data.get("segments", input_data)
            output = score_single(model, segments)
        elif mode == "compare":
            output = score_compare(
                model,
                input_data["sources"],
                input_data["references"],
                input_data["systems"]
            )
        else:
            raise ValueError(f"Unknown mode: {mode}")
        
        print(json.dumps(output))
        
    except Exception as e:
        error_output = {
            "error": str(e),
            "type": type(e).__name__
        }
        print(json.dumps(error_output), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
