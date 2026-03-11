import base64
import gzip
import json
import os

import boto3


sns = boto3.client("sns")

FAILURE_ALERT_TOPIC_ARN = os.environ["FAILURE_ALERT_TOPIC_ARN"]
DEBUG_OUTCOME_TOPIC_ARN = os.environ["DEBUG_OUTCOME_TOPIC_ARN"]
ENABLE_DEBUG_OUTCOME_NOTICES = (
    os.environ.get("ENABLE_DEBUG_OUTCOME_NOTICES", "true").lower() == "true"
)


def publish(topic_arn, subject, payload):
    sns.publish(
        TopicArn=topic_arn,
        Subject=subject[:100],
        Message=json.dumps(payload, ensure_ascii=False),
    )


def classify_message(message):
    log = json.loads(message)
    msg = log.get("msg")
    action = log.get("action")

    if msg == "快照執行完成":
        return ("snapshot_success", "debug", log)
    if msg == "今日快照已成功完成，略過（idempotent）":
        return ("snapshot_skipped", "debug", log)
    if msg == "快照執行失敗":
        return ("snapshot_failed", "failure_and_debug", log)
    if msg == "每月回報執行完成":
        return ("report_success", "debug", log)
    if msg == "每月回報已成功送出，略過（idempotent）":
        return ("report_skipped", "debug", log)
    if msg == "每月回報執行失敗":
        return ("report_failed", "failure_and_debug", log)
    if log.get("level") == "error":
        event_name = f"{action}_runtime_error" if action else "runtime_error"
        return (event_name, "failure", log)

    return None


def handler(event, _context):
    encoded = event["awslogs"]["data"]
    decoded = gzip.decompress(base64.b64decode(encoded))
    payload = json.loads(decoded)

    for log_event in payload.get("logEvents", []):
        try:
            classified = classify_message(log_event["message"])
        except Exception:
            continue

        if not classified:
            continue

        event_name, route, log = classified
        notice = {
            "service": "line-report",
            "route": route,
            "event": event_name,
            "timestamp": log.get("time"),
            "level": log.get("level"),
            "action": log.get("action"),
            "jobId": log.get("jobId"),
            "monthKey": log.get("monthKey"),
            "targetMonthKey": log.get("targetMonthKey"),
            "totalUsage": log.get("totalUsage"),
            "error": log.get("error"),
            "msg": log.get("msg"),
            "logStream": payload.get("logStream"),
            "logGroup": payload.get("logGroup"),
        }

        if route in ("failure", "failure_and_debug"):
            publish(FAILURE_ALERT_TOPIC_ARN, f"[line-report] {event_name}", notice)

        if ENABLE_DEBUG_OUTCOME_NOTICES and route in ("debug", "failure_and_debug"):
            publish(DEBUG_OUTCOME_TOPIC_ARN, f"[line-report] {event_name}", notice)
