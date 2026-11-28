"""Create the plugin-owned runtime when discovery finds nothing compatible.

A private virtual environment under the plugin's data directory, populated with the
pinned distribution by its own `python -m pip`. No existing environment is changed, no
GPU extra is installed, nothing runs with elevated privileges, and a created environment
is never moved.
"""
