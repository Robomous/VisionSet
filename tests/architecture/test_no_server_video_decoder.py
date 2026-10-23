"""No server-side video decoder is loaded or launched, proved in a fresh interpreter.

`tests/scripts/no_server_video_decode.test.mjs` bans decoder *names* in tracked
files, and says plainly what that cannot see: a name assembled at run time
(`"ff" + "mpeg"`, a binary read from the environment), a decoder nobody has listed
yet, and a dependency that decodes without naming itself. No pattern closes those
holes, because the thing to look at is not the text but what the process does.

This file looks at what the process does. It imports every module the
distribution ships, builds the application, and records two facts that no spelling
can hide:

- **which modules ended up loaded.** A decoding library is a module in
  `sys.modules` whatever route brought it — a direct import, an extra, or a
  dependency three levels down.
- **which programs were started.** An audit hook sees the executable a
  `subprocess` call was actually given, after any string concatenation or
  environment lookup has already happened.

A subprocess, on `test_optional_runtime.py`'s terms: `sys.modules` in *this*
interpreter has been filled by the rest of the suite, so the only honest place to
ask "what did importing this load?" is an interpreter that has imported nothing
else.

What this still does not prove is that nothing *would* decode given the right
input: it covers import and application construction, not every code path. It is
a runtime tripwire to stand beside the name-based one, not a sandbox.
"""

from __future__ import annotations

import json
import subprocess
import sys

#: Top-level modules that read a clip on this machine. Deliberately the module
#: names rather than the distribution names the script gate scans for — `av`,
#: `imageio_ffmpeg` and `decord` are what `sys.modules` holds.
DECODER_MODULES = frozenset(
    {
        "av",
        "decord",
        "ffmpeg",
        "imageio",
        "imageio_ffmpeg",
        "moviepy",
        "skvideo",
        "torchcodec",
        "vidgear",
    }
)

#: Program names that must never be started. Compared against the basename of what
#: was actually executed, lower-cased and stripped of an `.exe` suffix.
DECODER_PROGRAMS = frozenset({"ffmpeg", "ffprobe", "ffplay", "avconv", "avprobe"})

_PROBE = """
import importlib
import json
import os
import pkgutil
import sys

spawned = []


def _hook(event, args):
    if event in ("subprocess.Popen", "os.exec", "os.posix_spawn", "os.spawn"):
        spawned.append(str(args[0]))
    elif event == "os.system":
        spawned.append(str(args[0]))


sys.addaudithook(_hook)

import visionset

unimportable = []
for info in pkgutil.walk_packages(visionset.__path__, "visionset.", onerror=lambda name: None):
    try:
        importlib.import_module(info.name)
    except ImportError:
        # A module that needs an extra which is not installed. It loaded nothing.
        unimportable.append(info.name)

from visionset.server.main import create_app

create_app()

loaded = sorted({name.split(".")[0] for name in sys.modules})
print(json.dumps({"loaded": loaded, "spawned": spawned, "unimportable": unimportable}))
"""


def _observe() -> dict[str, list[str]]:
    result = subprocess.run([sys.executable, "-c", _PROBE], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def _program(command: str) -> str:
    name = command.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name.removesuffix(".exe")


def test_importing_everything_and_building_the_app_loads_no_decoder() -> None:
    observed = _observe()
    loaded = DECODER_MODULES & set(observed["loaded"])
    assert not loaded, f"the distribution pulled in a server-side video decoder: {sorted(loaded)}"


def test_importing_everything_and_building_the_app_starts_no_decoder_program() -> None:
    observed = _observe()
    started = [command for command in observed["spawned"] if _program(command) in DECODER_PROGRAMS]
    assert not started, f"the distribution started a server-side video decoder: {started}"


def test_the_probe_sees_what_it_claims_to() -> None:
    """A tripwire nobody has seen fire is one nobody knows works.

    The program name is assembled the way the script gate cannot read — two
    halves joined at run time — and the decoder module is faked into
    `sys.modules` rather than installed, so this needs no real decoder.
    """
    probe = """
import json
import subprocess
import sys

spawned = []


def hook(event, args):
    if event == "subprocess.Popen":
        spawned.append(str(args[0]))


sys.addaudithook(hook)

name = "ff" + "mpeg"
try:
    subprocess.run([name, "-version"], capture_output=True)
except OSError:
    pass  # not installed here; the audit event fires before the exec fails

sys.modules["av"] = object()
print(json.dumps({"loaded": sorted(sys.modules), "spawned": spawned}))
"""
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    observed = json.loads(result.stdout.strip().splitlines()[-1])
    assert "av" in DECODER_MODULES & set(observed["loaded"])
    assert any(_program(command) in DECODER_PROGRAMS for command in observed["spawned"])
