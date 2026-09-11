"""Hermes plugin entry point for persistent Pi orchestration."""

from importlib import import_module


def register(ctx) -> None:
    """Register plugin capabilities."""
    import_module(f"{__package__}.pi_orchestrator.runtime").register_plugin(ctx)
