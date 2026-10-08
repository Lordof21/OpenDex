"""Entry point of the packaged sidecar (build_nuitka.py compiles THIS file).

`app/main.py` uses package-relative imports (`from . import logging_config`), so compiling it as the main script died at
startup with "ImportError: attempted relative import with no known parent package" (the Tauri log showed the sidecar
exiting with code 1 on every launch). `python -m app.main` works because `-m` supplies the package; a frozen build has no
`-m`, so the program starts here and imports `app.main` as the package module it is."""
from app.main import run

if __name__ == "__main__":
    run()
