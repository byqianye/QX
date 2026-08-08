# Runtime report

All four runtime manifest entries are bundled: JRE Eclipse Temurin 21.0.7+6, CPython 3.12.10 embeddable, mpv git 21277b0ccf, aria2 1.37.0.

The Python bundle contains `requirements-lock.txt` declaring standard-library-only dependencies and uses `python312._pth` plus sanitized packaged environment variables.
Size report (bytes): JRE 32,199,101; CPython 22,501,604; mpv 120,205,564; aria2 5,754,502; electron-runtime total 180,700,729; portable packaged directory 2,356,785,019; latest NSIS setup 170,781,747.
