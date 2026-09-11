from importlib import import_module

parse_choice = import_module("pi_orchestrator.choice_parser").parse_choice


def test_accepts_one_explicit_choice():
    assert parse_choice("Queue") == "queue"
    assert parse_choice("Please choose parallel.") == "parallel"
    assert parse_choice("use steer") == "steer"


def test_rejects_ambiguous_negated_and_embedded_choices():
    assert parse_choice("queue or parallel") is None
    assert parse_choice("do not steer") is None
    assert parse_choice("I think queue might be best") is None
    assert parse_choice("continue") is None
