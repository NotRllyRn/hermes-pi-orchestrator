"""Deterministic evidence parser for the mandatory concurrency choice."""

from __future__ import annotations

import re

CHOICES = ("queue", "steer", "parallel")


def parse_choice(message: str) -> str | None:
    """Return one explicit choice, rejecting ambiguity and negation."""
    normalized = " ".join(message.lower().strip().split())
    found = [choice for choice in CHOICES if re.search(rf"\b{choice}\b", normalized)]
    if len(found) != 1:
        return None
    choice = found[0]
    if re.search(rf"\b(?:not|don't|do not|never)\s+(?:choose\s+)?{choice}\b", normalized):
        return None
    allowed = {
        choice,
        f"choose {choice}",
        f"use {choice}",
        f"{choice} it",
        f"please {choice}",
        f"please choose {choice}",
    }
    stripped = normalized.strip(" .,!?:;\"'")
    return choice if stripped in allowed else None
