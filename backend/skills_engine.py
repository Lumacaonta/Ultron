from __future__ import annotations

import json
import re
import subprocess
import webbrowser
from pathlib import Path
from typing import Any

from auth import get_current_user, get_user_data_dir


DEFAULT_SKILLS = [
    {
        "id": "open-web",
        "name": "Open Websites",
        "description": "Open websites and URLs.",
        "trigger": "apri sito",
        "action": "open_url",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "open-apps",
        "name": "Mac Applications",
        "description": "Launch installed Mac applications.",
        "trigger": "apri app",
        "action": "open_app",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "research",
        "name": "Web Research",
        "description": "Search the web and summarize information.",
        "trigger": "cerca informazioni",
        "action": "research",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "obsidian",
        "name": "Obsidian",
        "description": "Use the connected Obsidian knowledge vault.",
        "trigger": "salva su obsidian",
        "action": "research_obsidian",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "memory",
        "name": "Memory",
        "description": "Use ULTRON long-term memory.",
        "trigger": "ricorda",
        "action": "memory",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "weather",
        "name": "Weather",
        "description": "Weather integration.",
        "trigger": "meteo",
        "action": "weather",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "email",
        "name": "Email",
        "description": "Read and search email.",
        "trigger": "controlla email",
        "action": "email",
        "target": "",
        "enabled": True,
        "builtin": True,
    },
    {
        "id": "lights",
        "name": "Smart Lights",
        "description": "Control connected smart lights.",
        "trigger": "accendi luce",
        "action": "lights",
        "target": "",
        "enabled": False,
        "builtin": True,
    },
    {
        "id": "printer",
        "name": "3D Printer",
        "description": "Monitor a connected 3D printer.",
        "trigger": "controlla stampante",
        "action": "printer",
        "target": "",
        "enabled": False,
        "builtin": True,
    },
]

BUILTIN_SKILL_IDS = {
    str(skill["id"])
    for skill in DEFAULT_SKILLS
}


def is_builtin_skill(skill_id: str) -> bool:
    """Return whether an id belongs to an ULTRON-provided skill."""

    return str(skill_id or "").strip() in BUILTIN_SKILL_IDS


def get_skill(skill_id: str) -> dict[str, Any] | None:
    for skill in load_skills():
        if skill.get("id") == skill_id:
            return skill

    return None


def upsert_skill(skill: dict[str, Any]) -> dict[str, Any]:
    skills = load_skills()

    skill_id = str(
        skill.get("id") or ""
    ).strip()

    if not skill_id:
        raise ValueError("Skill id is required.")

    replaced = False

    for index, current in enumerate(skills):
        if current.get("id") == skill_id:
            skills[index] = skill
            replaced = True
            break

    if not replaced:
        skills.append(skill)

    save_skills(skills)

    return skill


def delete_skill(skill_id: str) -> bool:
    skills = load_skills()
    filtered = [
        skill
        for skill in skills
        if skill.get("id") != skill_id
    ]

    if len(filtered) == len(skills):
        return False

    save_skills(filtered)
    return True


def _normalise(value: str) -> str:
    return re.sub(
        r"\s+",
        " ",
        value.lower().strip(),
    )


def _find_custom_trigger(
    text: str,
    skill: dict[str, Any],
) -> bool:
    trigger = _normalise(
        str(skill.get("trigger") or "")
    )

    if not trigger:
        return False

    return (
        text == trigger
        or text.startswith(trigger + " ")
    )


def _open_target(
    target: str,
    action: str,
) -> dict[str, Any]:
    target = target.strip()

    if not target:
        return {
            "reply": "The skill needs a target.",
            "action": "skill_error",
        }

    if action == "open_url":
        url = target

        if not re.match(
            r"^https?://",
            url,
            re.IGNORECASE,
        ):
            url = "https://" + url

        webbrowser.open(url)

        return {
            "reply": "Opening the requested website.",
            "action": "open_url",
        }

    if action == "open_app":
        app_path = Path(target).expanduser()

        if target.startswith(("/", "~")):
            if not app_path.exists() or app_path.suffix.lower() != ".app":
                return {
                    "reply": "The selected application could not be found.",
                    "action": "skill_error",
                }
            command = ["open", str(app_path)]
        else:
            command = ["open", "-a", target]

        try:
            subprocess.Popen(command)
        except OSError:
            return {
                "reply": "ULTRON could not open that application.",
                "action": "skill_error",
            }

        return {
            "reply": f"Opening {target}.",
            "action": "open_app",
        }

    return {
        "reply": "Unknown skill action.",
        "action": "skill_error",
    }


def execute_skill_for_message(
    message: str,
    text: str,
    *,
    ollama_url: str | None = None,
    ollama_model: str | None = None,
) -> dict[str, Any] | None:

    skills = load_skills()

    # ---------------------------------------------------------
    # GENERIC BUILTIN INTENTS
    # ---------------------------------------------------------

    wants_open = text.startswith(
        (
            "apri ",
            "open ",
            "lancia ",
            "launch ",
            "vai su ",
            "vai a ",
            "go to ",
        )
    )

    if wants_open:
        skill_id = (
            "open-apps"
            if not re.match(
                r"^(https?://|www\.|[a-z0-9.-]+\.[a-z]{2,})",
                text.split(" ", 1)[1],
                re.IGNORECASE,
            )
            else "open-web"
        )

        skill = get_skill(skill_id)

        if skill and not skill.get("enabled", True):
            return {
                "reply": f"Skill '{skill['name']}' is disabled in Settings.",
                "action": "skill_disabled",
            }

        return None

    research_skill = get_skill("research")

    email_skill = get_skill("email")

    if text.startswith(
        (
            "apri email",
            "apri mail",
            "open email",
        )
    ):
        if email_skill and not email_skill.get(
            "enabled",
            True,
        ):
            return {
                "reply": "Email is disabled in Settings.",
                "action": "skill_disabled",
            }

        try:
            from email_service import (
                EmailServiceError,
                open_email,
            )

            result = open_email("mail")
            return {
                "reply": result["message"],
                "action": "email_open",
            }
        except EmailServiceError as error:
            return {
                "reply": str(error),
                "action": "email_error",
            }

    is_research_request = (
        text.startswith("cerca ")
        or text.startswith("ricerca ")
        or text.startswith("trova informazioni ")
        or text.startswith("trova info ")
        or text.startswith("search ")
        or text.startswith("research ")
    )

    if is_research_request:
        if research_skill and not research_skill.get(
            "enabled",
            True,
        ):
            return {
                "reply": "Web Research is disabled in Settings.",
                "action": "skill_disabled",
            }

        try:
            from research import research_topic

            result = research_topic(
                message,
                ollama_url,
                ollama_model,
            )

            return {
                "reply": result["reply"],
                "action": "research",
                "sources": result.get("sources", []),
            }
        except Exception as error:
            return {
                "reply": f"Research error: {error}",
                "action": "research_error",
            }

    # ---------------------------------------------------------
    # CUSTOM SKILLS
    # ---------------------------------------------------------

    for skill in skills:
        if not skill.get("enabled", True):
            continue

        if skill.get("builtin"):
            continue

        if not _find_custom_trigger(
            text,
            skill,
        ):
            continue

        action = str(
            skill.get("action") or ""
        ).strip()

        target = str(
            skill.get("target") or ""
        ).strip()

        if action in {
            "open_url",
            "open_app",
        }:
            if not target:
                target = message[
                    len(
                        str(
                            skill.get(
                                "trigger"
                            ) or ""
                        )
                    ):
                ].strip()

            return _open_target(
                target,
                action,
            )

        if action == "research":
            try:
                from research import research_topic

                result = research_topic(
                    message,
                    ollama_url,
                    ollama_model,
                )

                return {
                    "reply": result["reply"],
                    "action": "research",
                    "sources": result.get(
                        "sources",
                        [],
                    ),
                }

            except Exception as error:
                return {
                    "reply": f"Research error: {error}",
                    "action": "research_error",
                }

        if action == "ask_ai":
            return None

        return {
            "reply": f"Skill '{skill.get('name', 'Unnamed')}' is active but its action is not implemented yet.",
            "action": "skill_pending",
        }

    return None

# =========================================================
# ULTRON — PERSISTENT USER SKILLS
# Custom skills must live outside the packaged application.
# =========================================================

import json as _SkillJson


def _user_skills_file() -> Path:
    """Return the current account's skills file.

    User skills are never loaded from a source or package directory. This
    prevents a project maintainer's local commands from being seeded into an
    account created from the public application.
    """

    user = get_current_user()
    user_id = str((user or {}).get("id") or "").strip()
    if not user_id:
        raise RuntimeError("An authenticated ULTRON account is required for skills access.")
    return get_user_data_dir(user_id) / "skills.json"


def _normalise_saved_skills(
    skills: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep the built-in skills available after upgrades and edits."""

    normalised: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for skill in skills:
        if not isinstance(skill, dict):
            continue

        current = dict(skill)
        skill_id = str(current.get("id") or "").strip()

        if not skill_id or skill_id in seen_ids:
            continue

        seen_ids.add(skill_id)
        builtin = is_builtin_skill(skill_id)
        current["id"] = skill_id
        current["builtin"] = builtin
        current["custom"] = not builtin
        normalised.append(current)

    for default in DEFAULT_SKILLS:
        if default["id"] in seen_ids:
            continue

        normalised.append({
            **default,
            "builtin": True,
            "custom": False,
        })

    return normalised


def save_skills(skills: list[dict[str, Any]]) -> None:
    skills_file = _user_skills_file()
    skills_file.parent.mkdir(parents=True, exist_ok=True)

    temp_file = skills_file.with_suffix(".tmp")

    with temp_file.open("w", encoding="utf-8") as handle:
        _SkillJson.dump(
            skills,
            handle,
            ensure_ascii=False,
            indent=2,
        )

    temp_file.replace(skills_file)

    try:
        skills_file.chmod(0o600)
    except OSError:
        pass


def load_skills() -> list[dict[str, Any]]:
    skills_file = _user_skills_file()

    if skills_file.exists():
        try:
            with skills_file.open(
                "r",
                encoding="utf-8",
            ) as handle:
                data = _SkillJson.load(handle)

            if isinstance(data, list):
                normalised = _normalise_saved_skills(data)
                if normalised != data:
                    save_skills(normalised)
                return normalised

        except Exception:
            pass

    defaults = _normalise_saved_skills(DEFAULT_SKILLS)
    save_skills(defaults)
    return defaults
