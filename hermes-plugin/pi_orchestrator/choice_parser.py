"""Deterministic evidence parsers for human-gated mutations."""

from __future__ import annotations

import re


def _normalized(message: str) -> str:
    return " ".join(message.lower().strip().strip(" .,!?:;\"'").split())


def _parse(message: str, aliases: dict[str, set[str]]) -> str | None:
    normalized = _normalized(message)
    matches = [choice for choice, phrases in aliases.items() if normalized in phrases]
    if len(matches) != 1:
        return None
    return matches[0]


def parse_choice(message: str) -> str | None:
    """Parse exactly one Queue/Steer/Parallel choice."""
    return _parse(message, {
        "queue": {"queue", "choose queue", "use queue", "queue it", "please queue", "please choose queue",
                  "1", "option 1", "wait", "wait / queue it"},
        "steer": {"steer", "choose steer", "use steer", "steer it", "please steer", "please choose steer",
                  "2", "option 2", "interrupt", "interrupt it", "redirect"},
        "parallel": {"parallel", "choose parallel", "use parallel", "please parallel", "please choose parallel",
                     "3", "option 3", "new branch", "work in parallel"},
    })


def parse_dirty_choice(message: str) -> str | None:
    """Parse the exceptional dirty-tree choice."""
    return _parse(message, {
        "wait": {"wait", "wait for clean", "wait for a clean state", "1", "option 1"},
        "head": {"head", "committed head", "start from head", "use current committed head",
                 "exclude uncommitted changes", "2", "option 2"},
    })


def parse_integration(message: str) -> str | None:
    """Parse one explicit child integration strategy from a user request."""
    normalized = _normalized(message).replace("-", "_")
    patterns = {
        "merge": r"\bmerge\b",
        "cherry_pick": r"\bcherry[ _]pick\b",
        "leave_branch": r"\bleave (?:the )?branch\b|\bretain (?:the )?branch\b",
    }
    found = [choice for choice, pattern in patterns.items() if re.search(pattern, normalized)]
    if len(found) != 1 or re.search(r"\b(?:don't|do not|never)\b", normalized):
        return None
    return found[0]


def parse_approval(message: str) -> str | None:
    """Parse explicit break-glass approval or denial."""
    return _parse(message, {
        "approve": {"approve break glass", "approve breakglass", "approve recovery access", "yes approve break glass"},
        "deny": {"deny break glass", "deny breakglass", "do not approve break glass"},
    })
