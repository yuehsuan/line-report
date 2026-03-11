import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import boto3


TAIPEI = ZoneInfo("Asia/Taipei")
ddb = boto3.client("dynamodb")
scheduler = boto3.client("scheduler")
cloudwatch = boto3.client("cloudwatch")


def resolve_checks(event: dict | None) -> set[str]:
    if not isinstance(event, dict):
        return {"snapshot", "report", "schedules"}
    checks = event.get("checks")
    if not isinstance(checks, list) or not checks:
        return {"snapshot", "report", "schedules"}
    return {str(check) for check in checks}


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def get_job_run(job_id: str) -> dict:
    table_name = os.environ["JOB_RUNS_TABLE"]
    response = ddb.get_item(
        TableName=table_name,
        Key={"jobId": {"S": job_id}},
        ConsistentRead=True,
    )
    return response.get("Item", {})


def get_str_attr(item: dict, name: str) -> str | None:
    if name not in item:
        return None
    value = item[name]
    return value.get("S")


def is_successful(item: dict) -> bool:
    return get_str_attr(item, "status") == "success"


def snapshot_healthy(now_taipei: datetime) -> float:
    now_utc = datetime.now(timezone.utc)
    lookback_start = now_utc - timedelta(hours=26)
    for days_ago in range(0, 3):
        date_key = (now_taipei - timedelta(days=days_ago)).strftime("%Y-%m-%d")
        item = get_job_run(f"snapshot#{date_key}")
        if not is_successful(item):
            continue
        finished_at = parse_iso_datetime(get_str_attr(item, "finishedAt"))
        updated_at = parse_iso_datetime(get_str_attr(item, "updatedAt"))
        completed_at = finished_at or updated_at
        if completed_at and completed_at >= lookback_start:
            return 1.0
    return 0.0


def nth_weekday_of_month(year: int, month: int, week_num: int, weekday_num: int) -> datetime:
    first_day = datetime(year, month, 1, tzinfo=TAIPEI)
    first_weekday = first_day.weekday()
    delta_days = (weekday_num - first_weekday) % 7
    day = 1 + delta_days + (week_num - 1) * 7
    return datetime(year, month, day, tzinfo=TAIPEI)


def report_due_datetime(year: int, month: int) -> datetime:
    mode = os.environ.get("REPORT_MODE", "date")
    hour = int(os.environ.get("REPORT_HOUR", "9"))
    if mode == "weekday":
        week_num = int(os.environ.get("REPORT_WEEK", "2"))
        weekday_num = int(os.environ.get("REPORT_WEEKDAY", "3")) - 1
        base = nth_weekday_of_month(year, month, week_num, weekday_num)
        return base.replace(hour=hour, minute=0, second=0, microsecond=0)
    day = int(os.environ.get("REPORT_DAY", "11"))
    return datetime(year, month, day, hour, 0, 0, tzinfo=TAIPEI)


def prev_month(year: int, month: int) -> tuple[int, int]:
    if month == 1:
        return year - 1, 12
    return year, month - 1


def most_recent_report_target_month(now_taipei: datetime) -> str:
    current_due = report_due_datetime(now_taipei.year, now_taipei.month)
    if current_due <= now_taipei:
        target_year, target_month = prev_month(now_taipei.year, now_taipei.month)
        return f"{target_year:04d}-{target_month:02d}"

    prev_due_year, prev_due_month = prev_month(now_taipei.year, now_taipei.month)
    target_year, target_month = prev_month(prev_due_year, prev_due_month)
    return f"{target_year:04d}-{target_month:02d}"


def report_healthy(now_taipei: datetime) -> float:
    target_month_key = most_recent_report_target_month(now_taipei)
    item = get_job_run(f"report#{target_month_key}")
    return 1.0 if is_successful(item) else 0.0


def schedule_enabled(name: str) -> float:
    response = scheduler.get_schedule(Name=name)
    return 1.0 if response.get("State") == "ENABLED" else 0.0


def put_metrics(metric_data: list[dict]) -> None:
    if not metric_data:
        return
    cloudwatch.put_metric_data(
        Namespace=os.environ.get("HEARTBEAT_NAMESPACE", "LineReportHeartbeat"),
        MetricData=metric_data,
    )


def handler(event, context):
    now_taipei = datetime.now(TAIPEI)
    checks = resolve_checks(event)
    metric_data = []
    result = {"checks": sorted(checks)}

    if "snapshot" in checks:
        snapshot_ok = snapshot_healthy(now_taipei)
        metric_data.append({"MetricName": "SnapshotHealthy", "Value": snapshot_ok, "Unit": "Count"})
        result["snapshot_ok"] = snapshot_ok

    if "report" in checks:
        report_ok = report_healthy(now_taipei)
        metric_data.append({"MetricName": "ReportHealthy", "Value": report_ok, "Unit": "Count"})
        result["report_ok"] = report_ok

    if "schedules" in checks:
        daily_schedule_ok = schedule_enabled(os.environ["DAILY_SNAPSHOT_SCHEDULE_NAME"])
        monthly_schedule_ok = schedule_enabled(os.environ["MONTHLY_REPORT_SCHEDULE_NAME"])
        metric_data.extend(
            [
                {
                    "MetricName": "DailySnapshotScheduleEnabled",
                    "Value": daily_schedule_ok,
                    "Unit": "Count",
                },
                {
                    "MetricName": "MonthlyReportScheduleEnabled",
                    "Value": monthly_schedule_ok,
                    "Unit": "Count",
                },
            ]
        )
        result["daily_schedule_ok"] = daily_schedule_ok
        result["monthly_schedule_ok"] = monthly_schedule_ok

    put_metrics(metric_data)
    return result
