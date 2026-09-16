import importlib.util
import sys
import types
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch


fake_boto3 = types.ModuleType("boto3")
fake_boto3.client = lambda _service_name: object()
sys.modules.setdefault("boto3", fake_boto3)

module_path = Path(__file__).parents[1] / "lambda" / "heartbeat_checker" / "index.py"
spec = importlib.util.spec_from_file_location("heartbeat_checker", module_path)
heartbeat_checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(heartbeat_checker)


class ReportHealthyTest(unittest.TestCase):
    def test_reads_current_publish_report_job_after_monthly_due_time(self):
        now_taipei = datetime(2026, 9, 16, 8, 5, tzinfo=heartbeat_checker.TAIPEI)
        successful_job = {"status": {"S": "success"}}

        with patch.object(
            heartbeat_checker,
            "get_job_run",
            return_value=successful_job,
        ) as get_job_run:
            result = heartbeat_checker.report_healthy(now_taipei)

        self.assertEqual(result, 1.0)
        get_job_run.assert_called_once_with("publish-report#2026-08")

    def test_checks_previous_due_month_before_current_month_due_time(self):
        now_taipei = datetime(2026, 9, 10, 8, 5, tzinfo=heartbeat_checker.TAIPEI)

        with patch.object(
            heartbeat_checker,
            "get_job_run",
            return_value={},
        ) as get_job_run:
            result = heartbeat_checker.report_healthy(now_taipei)

        self.assertEqual(result, 0.0)
        get_job_run.assert_called_once_with("publish-report#2026-07")


if __name__ == "__main__":
    unittest.main()
