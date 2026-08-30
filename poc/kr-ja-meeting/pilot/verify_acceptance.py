import hashlib
import json
import os
from pathlib import Path
import subprocess
import unittest


class PilotAcceptance(unittest.TestCase):
    def test_agent_only_gate(self):
        repository = Path(__file__).resolve().parents[3]
        package = repository / "poc" / "kr-ja-meeting"
        raw_path = Path(
            os.environ.get(
                "UA_AGENT_RAW_RESULTS_PATH",
                "/private/tmp/ua-agent-comparison/.ua-pilot/agent-lane-comparison/raw-results.json",
            )
        )
        output_path = repository / ".ua-pilot" / "agent-only-gate" / "adjudication.json"

        completed = subprocess.run(
            [
                "node",
                "scripts/adjudicate-agent-only-pilot.mjs",
                "--raw",
                str(raw_path),
                "--output",
                str(output_path),
            ],
            cwd=package,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(output_path.read_text())
        self.assertEqual(result["resultRouting"], "Stop Rule")
        self.assertEqual(result["contractVersion"], 3)
        self.assertEqual(
            result["scorer"],
            {
                "revision": "agent-only-gate-v4-frozen-manual",
                "inputContractVersion": 1,
                "outputContractVersion": 3,
            },
        )
        self.assertEqual(
            result["inputDigests"],
            {
                "benchmarkSha256": "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6",
                "rawResultsSha256": "6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0",
                "manualAdjudicationSha256": "135fe995bd491f8e5ff5cf9184c2153037bb59f8a7a05d5699f6cd7c7cdda786",
            },
        )
        self.assertEqual(
            result["manualAdjudication"]["ruleSha256"],
            "e205046c9a78211f03bce1ff298916ff131c5e492d1e6ed1298c1bd3bfabf9ab",
        )
        self.assertEqual(result["metrics"]["correctAnswers"], 4)
        self.assertEqual(result["metrics"]["evidencedAnswers"], 0)
        self.assertEqual(result["metrics"]["inventedFiles"], 0)
        self.assertEqual(result["metrics"]["inventedRelations"], 0)
        self.assertEqual(result["metrics"]["graphMedianMs"], 36840.065)
        self.assertEqual(result["metrics"]["repositorySearchMedianMs"], 33217.775)
        self.assertEqual(result["metrics"]["medianTimeReduction"], -0.109)
        self.assertEqual(
            hashlib.sha256(output_path.read_bytes()).hexdigest(),
            "e28b0c63e52ec06bfd17ce94b0b59423eeabfd3cb3df0849464e2af7255b1e4e",
        )


if __name__ == "__main__":
    unittest.main()
