"""Create the plugin-owned runtime when discovery finds nothing compatible.

A private virtual environment under the plugin's data directory, built from a local
Python 3.11 or newer and populated by its own `python -m pip` with a distribution inside the
compatibility range. No existing environment is changed, no GPU extra is installed, nothing
runs with elevated privileges, and a created environment is never moved.
"""
