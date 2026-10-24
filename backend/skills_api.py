from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from skills_engine import (
    delete_skill,
    get_skill,
    is_builtin_skill,
    load_skills,
    upsert_skill,
)


router = APIRouter(
    prefix="/api/skills",
    tags=["skills"],
)


# These are the safe, fully implemented action types that a person can choose
# when creating a custom skill from Settings. Built-in skills retain their
# own action type and can only be enabled or disabled.
CUSTOM_SKILL_ACTIONS = {
    "ask_ai",
    "open_app",
    "open_url",
    "research",
}


def _custom_action(value: str) -> str:
    action = str(value or "").strip()

    if action not in CUSTOM_SKILL_ACTIONS:
        raise HTTPException(
            status_code=422,
            detail="Custom skills must use a supported action.",
        )

    return action


class SkillRequest(BaseModel):
    id: str | None = None
    name: str
    description: str = ""
    trigger: str = ""
    action: str = "ask_ai"
    target: str = ""
    enabled: bool = True


@router.get("")
def list_skills():
    return {
        "ok": True,
        "skills": load_skills(),
    }


@router.post("")
def create_skill(request: SkillRequest):
    skill_id = (
        request.id
        or f"custom-{uuid.uuid4().hex[:12]}"
    )

    if is_builtin_skill(skill_id):
        raise HTTPException(
            status_code=409,
            detail="Built-in skills can only be updated.",
        )

    skill = {
        "id": skill_id,
        "name": request.name.strip(),
        "description": request.description.strip(),
        "trigger": request.trigger.strip(),
        "action": _custom_action(request.action),
        "target": request.target.strip(),
        "enabled": request.enabled,
        "builtin": False,
        "custom": True,
    }

    if not skill["name"]:
        raise HTTPException(
            status_code=400,
            detail="Skill name is required.",
        )

    if not skill["trigger"]:
        raise HTTPException(
            status_code=400,
            detail="Skill trigger is required.",
        )

    upsert_skill(skill)

    return {
        "ok": True,
        "skill": skill,
    }


@router.patch("/{skill_id}")
def update_skill(
    skill_id: str,
    request: SkillRequest,
):
    current = get_skill(skill_id)

    if current is None:
        raise HTTPException(
            status_code=404,
            detail="Skill not found.",
        )

    builtin = (
        is_builtin_skill(skill_id)
        or bool(current.get("builtin"))
    )

    if builtin:
        # Built-in commands implement their own trusted action path. Editing
        # their trigger or action from the generic skill form could otherwise
        # turn a working local integration into an unsupported command.
        skill = {
            **current,
            "enabled": request.enabled,
            "builtin": True,
            "custom": False,
        }
    else:
        skill = {
            "id": skill_id,
            "name": request.name.strip(),
            "description": request.description.strip(),
            "trigger": request.trigger.strip(),
            "action": _custom_action(request.action),
            "target": request.target.strip(),
            "enabled": request.enabled,
            "builtin": False,
            "custom": True,
        }

    upsert_skill(skill)

    return {
        "ok": True,
        "skill": skill,
    }


@router.delete("/{skill_id}")
def remove_skill(skill_id: str):
    if is_builtin_skill(skill_id):
        raise HTTPException(
            status_code=400,
            detail="Built-in skills cannot be deleted.",
        )

    if not delete_skill(skill_id):
        raise HTTPException(
            status_code=404,
            detail="Skill not found.",
        )

    return {
        "ok": True,
    }
