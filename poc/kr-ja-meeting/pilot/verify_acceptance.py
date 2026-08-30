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
        self.assertEqual(result["contractVersion"], 4)
        self.assertEqual(
            result["scorer"],
            {
                "revision": "agent-only-gate-v4-frozen-manual",
                "inputContractVersion": 1,
                "outputContractVersion": 4,
            },
        )
        self.assertEqual(
            result["inputDigests"],
            {
                "benchmarkSha256": "753c08d32feec639a4a8a161423d89c6a6c5389689e77cb4b0dde6d2f25fd4f6",
                "rawResultsSha256": "6f26882d2c0aec1099df082575e95e092be48fbbb17a3041e2ecd3947f7006e0",
                "manualAdjudicationSha256": "db4de619d182cc29596de7425cca8b7a4f4d9200a7527adf67c3ca6be06f9f14",
            },
        )
        self.assertEqual(
            result["manualAdjudication"]["ruleSha256"],
            "1b84496f7cf7d88221415a7099fc164dff29ea2d66c231aca690d8d7ea530a01",
        )
        self.assertEqual(
            result["manualAdjudication"]["reviewArtifactSha256"],
            {
                "reviewA": "770ece29a780a1ec72e0bd5e000ca659917c7c8a9ca260fa17f8056c3827918b",
                "reviewB": "307c134a238455aabcac29c65f8a34e073e0a016cce01e3ee804b954c8760c57",
                "tiebreak": "7785b81e5a97f33d6543bee2020af8570bff5f6ea771ebced970106e8b92e0e5",
            },
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
            "d8814efe662a6e8645c8923c12cbce0cfa73d87f7bf453d604ebe153f74a3c3a",
        )


if __name__ == "__main__":
    unittest.main()
