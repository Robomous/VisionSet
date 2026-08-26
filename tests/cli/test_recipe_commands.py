"""``visionset recipe``: a project's pre-processing recipes at a terminal."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from tests.cli._flow import ok, payload, plain, project, run, usage_error, workspace
from tests.cli.test_export_commands import _labeled_release

from visionset.kernel.services import EXPORT_REPORT_FILENAME


@pytest.fixture()
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("VISIONSET_WORKSPACE", raising=False)
    return workspace(tmp_path)


def test_create_from_flags_prints_the_name_and_list_shows_it(root: Path) -> None:
    name = project(root)

    created = ok(
        root,
        "recipe",
        "create",
        "lb",
        "-p",
        name,
        "--resize",
        "letterbox:640x640",
        "--augment",
        "hflip,brightness_contrast",
        "--variants",
        "2",
        "--target",
        "yolo11",
    )
    assert created.strip() == "lb"

    listed = ok(root, "recipe", "list", "-p", name)
    rows = [line.split() for line in plain(listed).splitlines()]
    assert rows[0][:4] == ["NAME", "TARGET", "STEPS", "VARIANTS"]
    assert rows[1][:2] == ["lb", "yolo11"]
    shown = payload(root, "recipe", "show", "lb", "-p", name)
    assert shown["spec"] == {
        "target": "yolo11",
        "steps": [
            {
                "kind": "resize",
                "strategy": "letterbox",
                "width": 640,
                "height": 640,
                "pad_value": 114,
            },
            {"kind": "augment", "op": "hflip", "amount": 0.2},
            {"kind": "augment", "op": "brightness_contrast", "amount": 0.2},
        ],
        "variants_per_asset": 2,
    }


def test_create_from_a_spec_file_reads_the_shape_show_json_prints(
    root: Path, tmp_path: Path
) -> None:
    name = project(root)
    ok(root, "recipe", "create", "a", "-p", name, "--resize", "stretch:320x240")
    shown = payload(root, "recipe", "show", "a", "-p", name)
    spec_file = tmp_path / "spec.json"
    spec_file.write_text(json.dumps(shown["spec"]), encoding="utf-8")

    ok(root, "recipe", "create", "b", "-p", name, "--spec", str(spec_file))

    assert payload(root, "recipe", "show", "b", "-p", name)["spec"] == shown["spec"]
    listed = payload(root, "recipe", "list", "-p", name)
    assert [row["name"] for row in listed["items"]] == ["a", "b"]
    assert listed["total"] == 2


def test_the_spec_file_and_the_flag_form_are_one_choice_at_exit_two(
    root: Path, tmp_path: Path
) -> None:
    name = project(root)
    spec_file = tmp_path / "spec.json"
    spec_file.write_text("{}", encoding="utf-8")

    both = run(
        root, "recipe", "create", "x", "-p", name, "--spec", str(spec_file), "--variants", "1"
    )
    neither = run(root, "recipe", "create", "x", "-p", name)

    assert both.exit_code == 2
    assert "either --spec or the flag form" in usage_error(both)
    assert neither.exit_code == 2
    assert "Say what the recipe does" in usage_error(neither)


def test_a_spec_that_breaks_the_grammar_is_refused_with_the_rule_at_exit_two(root: Path) -> None:
    name = project(root)

    result = run(root, "recipe", "create", "x", "-p", name, "--augment", "hflip")

    assert result.exit_code == 2
    assert "at least one variant" in usage_error(result)
    bad_resize = run(root, "recipe", "create", "x", "-p", name, "--resize", "crop:640x640")
    assert bad_resize.exit_code == 2
    assert "stretch, letterbox" in usage_error(bad_resize)
    bad_op = run(root, "recipe", "create", "x", "-p", name, "--augment", "blur", "--variants", "1")
    assert bad_op.exit_code == 2
    assert "blur" in usage_error(bad_op)


def test_a_taken_name_and_an_unknown_name_exit_one(root: Path) -> None:
    name = project(root)
    ok(root, "recipe", "create", "lb", "-p", name, "--resize", "letterbox:640x640")

    taken = run(root, "recipe", "create", "lb", "-p", name, "--resize", "letterbox:640x640")
    assert taken.exit_code == 1
    assert "already has a pre-processing recipe named 'lb'" in taken.output
    missing = run(root, "recipe", "show", "nope", "-p", name)
    assert missing.exit_code == 1
    assert "no pre-processing recipe named 'nope'" in missing.output


def test_update_replaces_the_spec_and_can_rename(root: Path) -> None:
    name = project(root)
    ok(root, "recipe", "create", "lb", "-p", name, "--resize", "letterbox:640x640")

    updated = payload(
        root,
        "recipe",
        "update",
        "lb",
        "-p",
        name,
        "--augment",
        "rot90",
        "--variants",
        "1",
        "--rename",
        "turns",
        "--json",
    )

    assert updated["name"] == "turns"
    assert updated["spec"]["steps"] == [{"kind": "augment", "op": "rot90", "amount": 0.2}]
    assert [row["name"] for row in payload(root, "recipe", "list", "-p", name)["items"]] == [
        "turns"
    ]


def test_delete_removes_it_and_says_so(root: Path) -> None:
    name = project(root)
    ok(root, "recipe", "create", "lb", "-p", name, "--resize", "letterbox:640x640")

    result = run(root, "recipe", "delete", "lb", "-p", name)

    assert result.exit_code == 0, result.output
    assert "Deleted recipe 'lb'" in result.output
    assert payload(root, "recipe", "list", "-p", name) == {"items": [], "total": 0}
    removed = payload(root, "recipe", "create", "lb", "-p", name, "--resize", "stretch:64x64")
    assert payload(root, "recipe", "delete", "lb", "-p", name)["deleted"]["id"] == removed["id"]


def test_export_with_a_recipe_writes_variants_and_records_the_recipe(
    root: Path, tmp_path: Path
) -> None:
    name, out = _labeled_release(root, tmp_path)
    ok(root, "release", "publish", "--tag", "split", "--project", name, "--split", "0.6,0.2,0.2")
    ok(
        root,
        "recipe",
        "create",
        "flip",
        "-p",
        name,
        "--resize",
        "letterbox:64x64",
        "--augment",
        "hflip",
        "--variants",
        "1",
    )

    result = payload(
        root,
        "export",
        "-p",
        name,
        "--release",
        "split",
        "-f",
        "ultralytics",
        "--recipe",
        "flip",
        "--allow-lossy",
        "--out",
        str(out),
        "--json",
    )

    assert result["preprocessing"]["recipe_name"] == "flip"
    assert result["augmented_file_count"] >= 1
    assert result["source_file_count"] + result["augmented_file_count"] == len(
        result["preprocessing"]["mapping"]
    )
    assert any(path.stem.endswith("-aug1") for path in (out / "labels" / "train").glob("*.txt"))
    report = json.loads((out / EXPORT_REPORT_FILENAME).read_text(encoding="utf-8"))
    assert report["preprocessing"]["recipe_hash"] == result["preprocessing"]["recipe_hash"]


def test_an_augmenting_recipe_over_an_unsplit_release_exits_one_on_check_and_export(
    root: Path, tmp_path: Path
) -> None:
    name, out = _labeled_release(root, tmp_path)
    ok(root, "recipe", "create", "flip", "-p", name, "--augment", "hflip", "--variants", "1")

    for extra in (["--check"], ["--out", str(out)]):
        result = run(
            root,
            "export",
            "-p",
            name,
            "--release",
            "v1.0",
            "-f",
            "dummy",
            "--recipe",
            "flip",
            *extra,
        )
        assert result.exit_code == 1, result.output
        assert "no split recipe" in result.output
    assert not out.exists()


def test_an_unknown_recipe_exits_one_naming_it(root: Path, tmp_path: Path) -> None:
    name, out = _labeled_release(root, tmp_path)

    result = run(
        root,
        "export",
        "-p",
        name,
        "--release",
        "v1.0",
        "-f",
        "ultralytics",
        "--recipe",
        "nope",
        "--out",
        str(out),
    )

    assert result.exit_code == 1
    assert "no pre-processing recipe named 'nope'" in result.output
