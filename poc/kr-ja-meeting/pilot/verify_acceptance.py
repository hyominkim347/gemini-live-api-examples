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
        self.assertEqual(result["contractVersion"], 2)
        self.assertEqual(
            result["scorer"],
            {
                "revision": "agent-only-gate-v3",
                "inputContractVersion": 1,
                "outputContractVersion": 2,
            },
        )
        self.assertEqual(result["metrics"]["correctAnswers"], 5)
        self.assertEqual(result["metrics"]["evidencedAnswers"], 0)
        self.assertEqual(result["metrics"]["inventedFiles"], 0)
        self.assertEqual(result["metrics"]["inventedRelations"], 0)
        self.assertEqual(result["metrics"]["graphMedianMs"], 36840.065)
        self.assertEqual(result["metrics"]["repositorySearchMedianMs"], 33217.775)
        self.assertEqual(result["metrics"]["medianTimeReduction"], -0.109)
        self.assertEqual(
            hashlib.sha256(output_path.read_bytes()).hexdigest(),
            "f3d9b86cde4792af752373ef2eb5e0829184259938c2006084a762591a968205",
        )


if __name__ == "__main__":
    unittest.main()
