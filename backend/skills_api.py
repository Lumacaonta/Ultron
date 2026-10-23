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
        "action": request.action.strip(),
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

    skill = {
        "id": skill_id,
        "name": request.name.strip(),
        "description": request.description.strip(),
        "trigger": request.trigger.strip(),
        "action": request.action.strip(),
        "target": request.target.strip(),
        "enabled": request.enabled,
        "builtin": builtin,
        "custom": not builtin,
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
