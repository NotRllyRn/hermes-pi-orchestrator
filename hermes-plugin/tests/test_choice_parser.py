from importlib import import_module

parser = import_module("pi_orchestrator.choice_parser")
parse_choice = parser.parse_choice
parse_dirty_choice = parser.parse_dirty_choice
parse_integration = parser.parse_integration


def test_accepts_one_explicit_choice():
    assert parse_choice("Queue") == "queue"
    assert parse_choice("Please choose parallel.") == "parallel"
    assert parse_choice("use steer") == "steer"


def test_rejects_ambiguous_negated_and_embedded_choices():
    assert parse_choice("queue or parallel") is None
    assert parse_choice("3") == "parallel"
    assert parse_choice("new branch") == "parallel"
    assert parse_dirty_choice("Committed HEAD") == "head"
    assert parse_dirty_choice("wait") == "wait"
    assert parse_choice("do not steer") is None
    assert parse_choice("I think queue might be best") is None
    assert parse_choice("continue") is None


def test_integration_requires_one_non_negated_strategy():
    assert parse_integration("Merge the child task") == "merge"
    assert parse_integration("Cherry-pick the child") == "cherry_pick"
    assert parse_integration("Leave the branch for later") == "leave_branch"
    assert parse_integration("Do not merge it") is None
    assert parse_integration("merge or cherry-pick") is None
