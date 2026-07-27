import copy
import pytest
import yaml
from harbor_buzz_orchestra import ExperimentManifest, ManifestError


def test_hash_is_independent_of_mapping_and_yaml_key_order(tmp_path, manifest_data):
    first = ExperimentManifest.load(manifest_data)
    path = tmp_path / "manifest.yaml"
    path.write_text(
        yaml.safe_dump(
            dict(reversed(list(copy.deepcopy(manifest_data).items()))), sort_keys=False
        )
    )
    second = ExperimentManifest.load(path)
    assert first.canonical_bytes() == second.canonical_bytes()
    assert first.sha256 == second.sha256
    assert len(first.sha256) == 64


def test_hash_changes_when_staffing_changes(manifest_data):
    first = ExperimentManifest.load(manifest_data)
    changed = copy.deepcopy(manifest_data)
    changed["roster"][1]["count"] = 3
    assert ExperimentManifest.load(changed).sha256 != first.sha256


@pytest.mark.parametrize(
    ("mutation", "match"),
    [
        (lambda data: data.update({"unknown": True}), "Extra inputs"),
        (lambda data: data["roster"].pop(0), "exactly one orchestrator"),
        (lambda data: data["prices"].pop("databricks/qwen"), "prices missing"),
        (lambda data: data["roster"][1].update({"concurrency": 5}), "concurrency"),
    ],
)
def test_invalid_manifest_is_rejected(manifest_data, mutation, match):
    mutation(manifest_data)
    with pytest.raises(ManifestError, match=match):
        ExperimentManifest.load(manifest_data)


def test_solo_roster_is_valid(manifest_data):
    """The single-agent baseline every multi-agent condition is measured against."""
    manifest_data["roster"] = [manifest_data["roster"][0]]
    manifest = ExperimentManifest.load(manifest_data)
    assert manifest.is_solo is True


def test_multi_agent_roster_is_not_solo(manifest_data):
    assert ExperimentManifest.load(manifest_data).is_solo is False


def test_temperature_is_rejected(manifest_data):
    """buzz-agent has no temperature knob; a manifest must not imply otherwise."""
    manifest_data["roster"][0]["generation"]["temperature"] = 0.0
    with pytest.raises(ManifestError, match="Extra inputs"):
        ExperimentManifest.load(manifest_data)


def test_non_mapping_document_is_rejected(tmp_path):
    path = tmp_path / "manifest.yaml"
    path.write_text("- not\n- a\n- mapping\n")
    with pytest.raises(ManifestError, match="root must be a mapping"):
        ExperimentManifest.load(path)


def generation(manifest_data, **overrides):
    manifest_data["roster"][0]["generation"].update(overrides)
    return ExperimentManifest.load(manifest_data).roster[0].generation


def test_compaction_is_unset_by_default(manifest_data):
    """Silence means "inherit the agent's defaults", not "pin them here"."""
    gen = generation(manifest_data)
    assert gen.compact_at_tokens is None
    assert gen.compact_at_percent is None


def test_compaction_knobs_are_accepted_together(manifest_data):
    """buzz-agent fires at whichever binds first, so both may be set."""
    gen = generation(
        manifest_data,
        context_window_tokens=1_000_000,
        max_output_tokens=4096,
        compact_at_percent=30,
        compact_at_tokens=272_000,
    )
    assert gen.compact_at_percent == 30
    assert gen.compact_at_tokens == 272_000


def test_a_target_the_output_reservation_would_override_is_rejected(manifest_data):
    """buzz-agent reserves room for the response, so this could never fire."""
    with pytest.raises(ManifestError, match="can never fire"):
        generation(
            manifest_data,
            context_window_tokens=200_000,
            max_output_tokens=4096,
            compact_at_tokens=199_000,
        )


@pytest.mark.parametrize("max_output_tokens", [200_000, 10_000_000])
def test_an_output_budget_that_fills_the_window_is_rejected(
    manifest_data, max_output_tokens
):
    """The failure mode is degraded behaviour, not an error, so catch it here.

    buzz-agent subtracts max_output_tokens from the window to pick its
    compaction threshold. At or above the window that threshold is zero, so the
    agent compacts on its first turn, exhausts max_handoffs, and silently
    truncates — a run that completes and reports plausible numbers while having
    thrown away its context.
    """
    with pytest.raises(ManifestError, match="must be less than"):
        generation(
            manifest_data,
            context_window_tokens=200_000,
            max_output_tokens=max_output_tokens,
        )


def test_an_out_of_range_percentage_is_rejected(manifest_data):
    with pytest.raises(ManifestError):
        generation(manifest_data, compact_at_percent=0)


def test_platform_prompt_is_part_of_the_condition_hash(manifest_data):
    """Turning [Base] off changes the system prompt, so it changes the condition.

    The sensitivity run and the run it is compared against differ in nothing
    else, so if this field were not hashed the two would be indistinguishable
    in the results — the one comparison the check exists to make.
    """
    baseline = ExperimentManifest.load(copy.deepcopy(manifest_data))
    assert baseline.roster[0].include_platform_prompt is True
    manifest_data["roster"][0]["include_platform_prompt"] = False
    assert ExperimentManifest.load(manifest_data).sha256 != baseline.sha256


def test_compaction_target_is_part_of_the_condition_hash(manifest_data):
    import copy

    baseline = ExperimentManifest.load(copy.deepcopy(manifest_data)).sha256
    manifest_data["roster"][0]["generation"]["compact_at_tokens"] = 100_000
    assert ExperimentManifest.load(manifest_data).sha256 != baseline
