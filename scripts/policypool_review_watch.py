#!/usr/bin/env python3
"""Poll OKX listing state and buried review messages for OKX ASPs."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path


AGENTS = {
    "4674": "PolicyPool",
    "4348": "Foreman",
    "3465": "GlassDesk",
}
HOME = Path.home()
ONCHAINOS = os.environ.get("ONCHAINOS_BIN", str(HOME / ".local" / "bin" / "onchainos"))
TASK_HOME = Path(os.environ.get("OKX_AGENT_TASK_HOME", HOME / ".okx-agent-task"))
STATE_PATH = TASK_HOME / "policypool-review-watch.json"
LOG_PATH = TASK_HOME / "logs" / "policypool-review-watch.log"
BACK_SESSION = TASK_HOME / "jobs" / "back-session.json"
TELEGRAM_ENV_PATH = Path(os.environ.get("POLICYPOOL_TELEGRAM_ENV", HOME / ".hermes" / ".env"))


def log(message: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n"
    LOG_PATH.open("a", encoding="utf-8").write(line)
    print(line, end="", flush=True)


def read_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def telegram_config() -> tuple[str, str] | None:
    env = read_dotenv(TELEGRAM_ENV_PATH)
    token = os.environ.get("TELEGRAM_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_HOME_CHANNEL") or os.environ.get("TELEGRAM_CHAT_ID") or env.get("TELEGRAM_HOME_CHANNEL", "")
    if not chat_id:
        allowed = os.environ.get("TELEGRAM_ALLOWED_USERS") or env.get("TELEGRAM_ALLOWED_USERS", "")
        chat_id = allowed.split(",", 1)[0].strip()
    return (token, chat_id) if token and chat_id else None


def notify(message: str) -> None:
    cfg = telegram_config()
    if not cfg:
        return
    token, chat_id = cfg
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": message[:3900],
        "disable_web_page_preview": "true",
    }).encode()
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data=data, timeout=10) as response:
            parsed = json.loads(response.read().decode("utf-8"))
        if not parsed.get("ok"):
            log("telegram ok=false")
    except Exception as exc:
        log(f"telegram failed {type(exc).__name__}: {str(exc)[:180]}")


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"seen": []}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {"seen": []}
    except Exception:
        return {"seen": []}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if len(state.get("seen", [])) > 200:
        state["seen"] = state["seen"][-200:]
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(STATE_PATH)


def get_agent_statuses() -> list[dict]:
    try:
        out = subprocess.run([ONCHAINOS, "agent", "get-my-agents"], capture_output=True, text=True, timeout=90).stdout
        payload = json.loads(out)
        statuses = []
        for account in payload.get("data", {}).get("list", []):
            for agent in account.get("agentList", []):
                agent_id = str(agent.get("agentId"))
                if agent_id in AGENTS:
                    statuses.append({
                        "agentId": str(agent.get("agentId")),
                        "name": agent.get("name"),
                        "approvalLabel": agent.get("approvalLabel"),
                        "statusLabel": agent.get("statusLabel"),
                        "onlineStatus": agent.get("onlineStatus"),
                        "approvalRemark": agent.get("approvalRemark"),
                    })
        return statuses
    except Exception as exc:
        log(f"status check failed {type(exc).__name__}: {str(exc)[:180]}")
    return []


def iter_raw_texts(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in {"rawText", "content", "text", "message"} and isinstance(nested, str):
                yield nested
            else:
                yield from iter_raw_texts(nested)
    elif isinstance(value, list):
        for item in value:
            yield from iter_raw_texts(item)


def scan_back_session(state: dict) -> None:
    if not BACK_SESSION.exists():
        return
    try:
        payload = json.loads(BACK_SESSION.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        log(f"back-session parse failed {type(exc).__name__}: {str(exc)[:180]}")
        return
    seen = set(state.get("seen", []))
    agent_needles = [name.lower() for name in AGENTS.values()] + [f"#{agent_id}" for agent_id in AGENTS]
    for text in iter_raw_texts(payload):
        lower_text = text.lower()
        if not any(needle.lower() in lower_text for needle in agent_needles):
            continue
        if not any(term in lower_text for term in ("review", "listing", "approved", "rejected", "live", "suspended", "adjustments")):
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        state.setdefault("seen", []).append(digest)
        notify("OKX agent review message found in backup log:\n" + text[:1200])


def main() -> None:
    state = load_state()
    statuses = get_agent_statuses()
    if statuses:
        key = json.dumps(statuses, sort_keys=True)
        if key != state.get("lastStatuses"):
            state["lastStatuses"] = key
            lines = []
            for status in statuses:
                lines.extend([
                    f"{status.get('name')} #{status.get('agentId')}",
                    f"approval={status.get('approvalLabel')}",
                    f"status={status.get('statusLabel')}",
                    f"online={status.get('onlineStatus')}",
                    f"remark={status.get('approvalRemark') or ''}",
                    "",
                ])
            notify(
                "OKX agent listing status update:\n"
                + "\n".join(lines).strip()
            )
            log(f"statuses changed {key}")
    scan_back_session(state)
    save_state(state)


if __name__ == "__main__":
    main()
