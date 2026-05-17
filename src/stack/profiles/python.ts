import type { StackProfile } from "./types.js";

export const pythonProfile: StackProfile = {
  id: "python",
  displayName: "Python",
  manifestFiles: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
  defaultTestCommand: "pytest -x",
  defaultBuildCommand: "python -m build",
  conventions: [
    "Source typically lives at the repo root or in a package directory matching the project name.",
    "Tests typically live in `tests/` and use pytest; some projects use unittest in `test_*.py` files.",
    "Package manifest is `pyproject.toml` (modern) or `setup.py`/`requirements.txt` (legacy).",
    "Virtualenvs commonly in `.venv/`, `venv/`, or `__pypackages__/`; uv/poetry/pipenv may manage them.",
    "Common entry points: `__main__.py`, `cli.py`, console_scripts in pyproject.",
  ],
};
