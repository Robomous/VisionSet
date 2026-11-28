"""Find an existing VisionSet installation the bundle's compatibility rule accepts.

Order: the user's installation, then the project's, then the plugin-owned runtime.
A candidate is only ever run, never modified.
"""
